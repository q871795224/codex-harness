use serde::{Deserialize, Serialize};

/// Built-in checkers accept data only. No executable, shell, URL host or API path overrides.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Target {
    #[default]
    Custom,
    Sleep {
        #[serde(rename = "wakeAt")]
        wake_at: u64,
    },
    GitlabCi {
        project: String,
        pipeline: u64,
        sha: String,
    },
    GithubCi {
        repo: String,
        pr: u64,
        sha: String,
    },
    Sdp {
        service: String,
        environment: String,
        callback: String,
        sha: String,
        tasks: Vec<String>,
    },
    Seatalk {
        reference: String,
        after: String,
        #[serde(rename = "excludeSender")]
        exclude_sender: String,
    },
}
impl Target {
    pub fn notify_only(&self) -> bool {
        matches!(
            self,
            Self::GitlabCi { .. } | Self::GithubCi { .. } | Self::Sdp { .. }
        )
    }
    pub fn validate(&self, now: u64) -> Result<(), String> {
        let identifier = |s: &str| {
            !s.is_empty()
                && s.len() <= 512
                && s.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"-_. /".contains(&c))
                && !s.contains(' ')
                && !s.starts_with('-')
                && s.split('/')
                    .all(|part| !part.is_empty() && !matches!(part, "." | ".."))
        };
        let sha = |s: &str| s.len() == 40 && s.bytes().all(|c| c.is_ascii_hexdigit());
        let valid = match self {
            Self::Custom => true,
            Self::Sleep { wake_at } => *wake_at > now && *wake_at <= now + 365 * 86400,
            Self::GitlabCi {
                project,
                pipeline,
                sha: commit,
            } => identifier(project) && *pipeline > 0 && sha(commit),
            Self::GithubCi {
                repo,
                pr,
                sha: commit,
            } => identifier(repo) && repo.split('/').count() == 2 && *pr > 0 && sha(commit),
            Self::Sdp {
                service,
                environment,
                callback,
                sha: commit,
                tasks,
            } => {
                identifier(service)
                    && matches!(
                        environment.as_str(),
                        "test" | "stable" | "uat" | "staging" | "liveish" | "live"
                    )
                    && identifier(callback)
                    && sha(commit)
                    && !tasks.is_empty()
                    && tasks.len() <= 64
                    && tasks
                        .iter()
                        .all(|t| identifier(t) && t.starts_with(&format!("{service}.")))
            }
            Self::Seatalk {
                reference,
                after,
                exclude_sender,
            } => {
                reference.len() <= 4096
                    && reqwest::Url::parse(reference).is_ok_and(|u| {
                        u.scheme() == "seatalk"
                            && u.host_str() == Some("conversation")
                            && ["owner_id", "target_type", "target_id", "message_id"]
                                .iter()
                                .all(|key| u.query_pairs().any(|(k, v)| k == *key && !v.is_empty()))
                    })
                    && identifier(after)
                    && identifier(exclude_sender)
            }
        };
        if valid {
            Ok(())
        } else {
            Err("异步任务目标参数无效；sleep 须在未来一年内，CI/部署须绑定完整提交 SHA".into())
        }
    }
    pub fn script(&self) -> Result<Vec<u8>, String> {
        let encoded =
            serde_json::to_string(&serde_json::to_string(self).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        Ok(format!(
            "SPEC = __import__('json').loads({encoded})\n{}",
            include_str!("checkers.py")
        )
        .into_bytes())
    }
}
