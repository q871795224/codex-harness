use std::{fs, io::ErrorKind, path::Path};

pub fn read(path: &Path, key: &str) -> Result<Option<String>, String> {
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("无法读取 Harness 密钥文件".into()),
    };
    parse(&content, key)
}

pub(crate) fn parse(content: &str, key: &str) -> Result<Option<String>, String> {
    let mut result = None;
    for line in content.lines() {
        let line = line.trim().strip_prefix("export ").unwrap_or(line.trim());
        let Some((name, value)) = line.split_once('=') else {
            continue;
        };
        if name.trim() != key {
            continue;
        }
        let value = value.trim();
        let value = if value.starts_with(['\'', '"']) {
            let quote = value.chars().next().unwrap();
            let Some(end) = value[1..].find(quote).map(|index| index + 1) else {
                return Err(format!("{key} 引号不完整"));
            };
            let tail = value[end + 1..].trim();
            if !tail.is_empty() && !tail.starts_with('#') {
                return Err(format!("{key} 格式无效"));
            }
            &value[1..end]
        } else {
            value
                .split_once(" #")
                .map_or(value, |(value, _)| value)
                .trim()
        };
        if value.is_empty() {
            result = None;
            continue;
        }
        if !value.bytes().all(|byte| byte.is_ascii_graphic()) {
            return Err(format!("{key} 格式无效"));
        }
        result = Some(value.to_owned());
    }
    Ok(result)
}
