use std::{
    fs,
    io::{ErrorKind, Write},
    path::Path,
};

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
        let Some((name, value)) = assignment(line) else {
            continue;
        };
        if name != key {
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

fn assignment(line: &str) -> Option<(&str, &str)> {
    let line = line.trim();
    let (name, value) = line
        .strip_prefix("export ")
        .unwrap_or(line)
        .split_once('=')?;
    Some((name.trim(), value))
}

pub fn write(path: &Path, key: &str, value: &str) -> Result<(), String> {
    let error = |_| "无法保存 Harness 密钥文件";
    let dir = path.parent().ok_or("Harness 密钥文件路径无效")?;
    let lock = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(dir.join("secrets.lock"))
        .map_err(error)?;
    lock.lock().map_err(error)?;

    let content = match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => fs::read_to_string(path).map_err(error)?,
        Ok(_) => return Err("Harness 密钥文件必须是普通文件".into()),
        Err(error) if error.kind() == ErrorKind::NotFound => String::new(),
        Err(_) => return Err("无法读取 Harness 密钥文件".into()),
    };
    // Preserve comments and every other assignment, including their line endings.
    let mut updated: String = content
        .split_inclusive('\n')
        .filter(|line| !assignment(line).is_some_and(|(name, _)| name == key))
        .collect();
    if !updated.is_empty() && !updated.ends_with('\n') {
        updated.push('\n');
    }
    let mut file = tempfile::NamedTempFile::new_in(dir).map_err(error)?;
    write!(file, "{updated}{key}={value}\n").map_err(error)?;
    file.as_file().sync_all().map_err(error)?;
    file.persist(path)
        .map_err(|_| "无法替换 Harness 密钥文件")?;
    Ok(())
}
