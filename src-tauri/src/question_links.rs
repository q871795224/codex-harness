use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Mutex;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct QuestionLocator {
    pub thread: String,
    pub turn: String,
    pub request: String,
    pub kind: String,
    pub question: String,
    pub revision: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub option: Option<u16>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QuestionNotification {
    pub locator: QuestionLocator,
    pub title: String,
    pub question: String,
    pub options: Vec<String>,
}
impl QuestionLocator {
    pub fn validate(&self) -> Result<(), String> {
        for value in [&self.thread, &self.turn, &self.request, &self.question] {
            if value.is_empty() || value.len() > 2048 || value.chars().any(char::is_control) {
                return Err("问题链接标识无效".into());
            }
        }
        if !matches!(self.kind.as_str(), "tool" | "async")
            || self.revision.len() != 64
            || !self
                .revision
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || self.option.is_some_and(|option| option > 9999)
        {
            return Err("问题链接版本或选项无效".into());
        }
        Ok(())
    }
    pub fn notification_key(&self) -> String {
        // A changed question revision or replay must not send a second card.
        format!(
            "questions.notified:{}",
            json!([
                self.thread,
                self.turn,
                self.kind,
                self.request,
                self.question
            ])
        )
    }
    pub fn bridge_link(&self, base: &str, option: Option<usize>) -> Result<String, String> {
        self.validate()?;
        let mut url = crate::local_connector::validate_base_url(base)?;
        url.set_path("/local/open/harness");
        let mut query = url.query_pairs_mut();
        for (key, value) in [
            ("thread", &self.thread),
            ("turn", &self.turn),
            ("request", &self.request),
            ("kind", &self.kind),
            ("question", &self.question),
            ("revision", &self.revision),
        ] {
            query.append_pair(key, value);
        }
        if let Some(option) = option {
            query.append_pair("option", &option.to_string());
        }
        drop(query);
        Ok(url.into())
    }
}

pub fn card_payload(
    base: &str,
    account: &str,
    target: &str,
    input: &QuestionNotification,
) -> Result<Value, String> {
    input.locator.validate()?;
    if input.locator.option.is_some()
        || account.trim().is_empty()
        || account.len() > 128
        || target.trim().is_empty()
        || target.len() > 512
    {
        return Err("通知账号或目标无效".into());
    }
    if input.question.len() > 20000
        || input.options.len() > 100
        || input.options.iter().any(|o| o.len() > 2000)
    {
        return Err("提问内容超过通知卡片限制".into());
    }
    let mut description = input.question.chars().take(1800).collect::<String>();
    for (index, option) in input.options.iter().enumerate() {
        description.push_str(&format!(
            "\n{}. {}",
            index + 1,
            option.chars().take(100).collect::<String>()
        ));
    }
    if description.chars().count() > 3800 {
        description =
            description.chars().take(3750).collect::<String>() + "\n更多内容请在 Harness 查看。";
    }
    if input.options.len() > 4 {
        description.push_str("\n其余选项请在 Harness 内填写。");
    }
    let button = |text: String, option| -> Result<Value, String> {
        Ok(
            json!({ "type": "redirect", "text": text, "desktop_link": {"type": "web", "path": input.locator.bridge_link(base, option)?} }),
        )
    };
    let mut buttons = vec![button("打开问题".into(), None)?];
    for (index, option) in input.options.iter().take(4).enumerate() {
        buttons.push(button(option.chars().take(50).collect(), Some(index))?);
    }
    Ok(
        json!({ "account": account, "target": {"type": "user", "id": target}, "message": {
        "type": "interactive", "title": input.title.chars().take(120).collect::<String>(), "description": description, "buttons": buttons
    } }),
    )
}

#[derive(Default)]
pub struct QuestionLinkInbox(Mutex<Vec<String>>);
impl QuestionLinkInbox {
    pub fn push(&self, url: &str) -> bool {
        if url.len() > 8192
            || Url::parse(url)
                .ok()
                .is_none_or(|u| u.scheme() != "codex-harness" || u.host_str() != Some("question"))
        {
            return false;
        }
        let Ok(mut queue) = self.0.lock() else {
            return false;
        };
        // Bound external input while the WebView boots. Never execute a URL here.
        if queue.len() < 64 {
            queue.push(url.to_owned());
        }
        true
    }
    pub fn drain(&self) -> Vec<String> {
        self.0
            .lock()
            .map(|mut q| std::mem::take(&mut *q))
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input() -> QuestionNotification {
        serde_json::from_value(json!({"locator":{"thread":"a&b","turn":"t","request":"1","kind":"tool","question":"q","revision":"a".repeat(64)},"title":"session","question":"choose","options":["A","B"]})).unwrap()
    }
    #[test]
    fn cards_only_carry_locators_and_option_indexes_in_desktop_links() {
        let input = input();
        let payload = card_payload("http://127.0.0.1:8787", "notify", "owner", &input).unwrap();
        let buttons = payload["message"]["buttons"].as_array().unwrap();
        assert_eq!(buttons.len(), 3);
        let link = buttons[1]["desktop_link"]["path"].as_str().unwrap();
        let url = Url::parse(link).unwrap();
        assert_eq!(
            url.query_pairs().find(|(k, _)| k == "thread").unwrap().1,
            "a&b"
        );
        assert_eq!(
            url.query_pairs().find(|(k, _)| k == "option").unwrap().1,
            "0"
        );
        assert!(buttons[1].get("mobile_link").is_none());
        assert!(!link.contains("choose"));
        assert!(card_payload("http://external.test:8787", "notify", "owner", &input).is_err());
    }
    #[test]
    fn updates_and_option_changes_keep_the_same_notification_identity() {
        let mut input = input();
        let key = input.locator.notification_key();
        input.locator.revision = "b".repeat(64);
        input.locator.option = Some(1);
        assert_eq!(key, input.locator.notification_key());
        input.locator.question = "second".into();
        assert_ne!(key, input.locator.notification_key());
    }
    #[test]
    fn notification_claim_survives_restart_and_coordinates_instances() {
        let dir = tempfile::tempdir().unwrap();
        let a = crate::store::HarnessStore::open_at(dir.path().to_path_buf()).unwrap();
        let b = crate::store::HarnessStore::open_at(dir.path().to_path_buf()).unwrap();
        let key = input().locator.notification_key();
        assert!(a.claim_question_notification(&key).unwrap());
        assert!(!b.claim_question_notification(&key).unwrap());
        drop(a);
        drop(b);
        let restarted = crate::store::HarnessStore::open_at(dir.path().to_path_buf()).unwrap();
        assert!(!restarted.claim_question_notification(&key).unwrap());
    }
    #[test]
    fn cold_start_and_running_links_are_drained_once() {
        let inbox = QuestionLinkInbox::default();
        assert!(!inbox.push("https://example.com/"));
        assert!(inbox.push("codex-harness://question?thread=a"));
        assert_eq!(inbox.drain(), vec!["codex-harness://question?thread=a"]);
        assert!(inbox.drain().is_empty());
    }
}
