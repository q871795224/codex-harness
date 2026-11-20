use std::{
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::OnceLock,
    time::Duration,
};

use serde::Deserialize;
use sha2::{Digest, Sha256};

const URL: &str = "https://github.com/PC2005-cloud/dsh-pet/releases/download/assets-mov/dsh-pet-mov-assets-mov.zip";
const SHA256: &str = "3e6be25298d0abbcc6e38e910d2d1726a4787c1f6c189c60cd17fa88abb4e21d";
const ARCHIVE_BYTES: u64 = 145_841_604;
const MAX_MOVIE_BYTES: u64 = 4 * 1024 * 1024;
pub(crate) static DOWNLOAD: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Status {
    Idle,
    Running,
    Waiting,
    Failed,
    Ready,
}

#[derive(Deserialize)]
struct Movies {
    states: std::collections::HashMap<Status, String>,
    idle: Vec<String>,
}

fn movies() -> &'static Movies {
    static MOVIES: OnceLock<Movies> = OnceLock::new();
    MOVIES.get_or_init(|| {
        serde_json::from_str(include_str!("../pets/dafeiyu/movies.json"))
            .expect("invalid bundled Dafeiyu movie list")
    })
}

pub(crate) fn count() -> usize {
    movies().idle.len()
}

pub(crate) fn directory() -> Result<PathBuf, String> {
    Ok(crate::store::harness_data_dir()?
        .join("pet-media")
        .join("dafeiyu-original-v1"))
}

pub(crate) fn installed(directory: &Path) -> bool {
    directory.join(".installed").is_file()
}

fn error(reason: impl std::fmt::Display) -> String {
    reason.to_string()
}

pub(crate) fn read(
    directory: &Path,
    status: Status,
    index: Option<usize>,
) -> Result<Vec<u8>, String> {
    if !installed(directory) {
        return Err("请先下载大肥鱼原画素材。".into());
    }
    let list = movies();
    let name = match index {
        Some(index) if status == Status::Idle => list.idle.get(index),
        Some(_) => None,
        None => list.states.get(&status),
    }
    .ok_or("大肥鱼动作不存在。")?;
    let path = directory.join(name);
    let file = fs::File::open(path).map_err(error)?;
    let mut bytes = Vec::new();
    file.take(MAX_MOVIE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(error)?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_MOVIE_BYTES {
        return Err("大肥鱼视频文件大小无效。".into());
    }
    Ok(bytes)
}

pub(crate) fn download(destination: &Path) -> Result<(), String> {
    if installed(destination) {
        return Ok(());
    }
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(error)?;
    let mut response = client
        .get(URL)
        .send()
        .and_then(|response| response.error_for_status())
        .map_err(error)?;
    let mut archive = tempfile::tempfile().map_err(error)?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut received = 0;
    loop {
        let count = response.read(&mut buffer).map_err(error)?;
        if count == 0 {
            break;
        }
        received += count as u64;
        if received > ARCHIVE_BYTES {
            return Err("GitHub 返回的大肥鱼素材包大小不符。".into());
        }
        archive.write_all(&buffer[..count]).map_err(error)?;
        digest.update(&buffer[..count]);
    }
    if received != ARCHIVE_BYTES || format!("{:x}", digest.finalize()) != SHA256 {
        return Err("大肥鱼素材包校验失败。".into());
    }
    install(archive, destination)
}

fn install(archive: impl Read + io::Seek, destination: &Path) -> Result<(), String> {
    let parent = destination.parent().ok_or("无效的大肥鱼素材目录。")?;
    fs::create_dir_all(parent).map_err(error)?;
    let staging = tempfile::tempdir_in(parent).map_err(error)?;
    let mut zip = zip::ZipArchive::new(archive).map_err(error)?;
    let list = movies();
    for name in list.idle.iter().chain(list.states.values()) {
        let mut entry = zip.by_name(name).map_err(error)?;
        if !entry.is_file() || entry.size() == 0 || entry.size() > MAX_MOVIE_BYTES {
            return Err(format!("大肥鱼视频文件无效：{name}"));
        }
        let mut file = fs::File::create(staging.path().join(name)).map_err(error)?;
        io::copy(&mut entry, &mut file).map_err(error)?;
    }
    fs::write(staging.path().join(".installed"), SHA256).map_err(error)?;
    match fs::rename(staging.path(), destination) {
        Ok(()) => Ok(()),
        Err(_) if installed(destination) => Ok(()),
        Err(reason) => Err(error(reason)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_only_the_selected_state_or_an_allowed_idle_clip() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("pack");
        assert!(!installed(&directory));
        let mut writer = zip::ZipWriter::new(io::Cursor::new(Vec::new()));
        let list = movies();
        assert_eq!(list.idle.len(), 89);
        let names: std::collections::HashSet<_> =
            list.idle.iter().chain(list.states.values()).collect();
        for name in names {
            writer
                .start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(name.as_bytes()).unwrap();
        }
        let source = writer.finish().unwrap().into_inner();
        install(io::Cursor::new(source), &directory).unwrap();
        assert_eq!(
            read(&directory, Status::Waiting, None).unwrap(),
            list.states[&Status::Waiting].as_bytes()
        );
        assert_eq!(
            read(&directory, Status::Idle, Some(0)).unwrap(),
            list.idle[0].as_bytes()
        );
        assert!(read(&directory, Status::Running, Some(0)).is_err());
        assert!(read(&directory, Status::Idle, Some(89)).is_err());
    }
}
