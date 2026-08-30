use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::Path,
    process::Command,
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Emitter};

const TERMINAL_EVENT: &str = "harness-terminal";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCreateInput {
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionInfo {
    pub session_id: String,
    pub shell: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
enum TerminalEvent {
    Output { session_id: String, data: String },
    Exit { session_id: String },
}

struct TerminalSession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct TerminalManager {
    sessions: Mutex<HashMap<String, TerminalSession>>,
}

impl TerminalManager {
    pub fn create(
        self: &Arc<Self>,
        app: AppHandle,
        input: TerminalCreateInput,
    ) -> Result<TerminalSessionInfo, String> {
        validate_cwd(&input.cwd)?;
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(pty_size(input.cols, input.rows))
            .map_err(|error| format!("无法创建终端 PTY: {error}"))?;
        let shell = login_shell();
        let mut command = CommandBuilder::new(&shell);
        command.arg("-l");
        command.arg("-i");
        command.cwd(&input.cwd);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");

        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| format!("无法启动终端 shell: {error}"))?;
        drop(pair.slave);
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| format!("无法读取终端输出: {error}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| format!("无法写入终端: {error}"))?;
        let session_id = uuid_like_id();

        self.sessions
            .lock()
            .map_err(|_| "终端会话锁已损坏".to_string())?
            .insert(
                session_id.clone(),
                TerminalSession {
                    master: pair.master,
                    writer,
                    child,
                },
            );

        let manager = Arc::clone(self);
        let reader_session_id = session_id.clone();
        std::thread::spawn(move || {
            let mut buffer = [0_u8; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(length) => {
                        let data = String::from_utf8_lossy(&buffer[..length]).into_owned();
                        let _ = app.emit(
                            TERMINAL_EVENT,
                            TerminalEvent::Output {
                                session_id: reader_session_id.clone(),
                                data,
                            },
                        );
                    }
                }
            }
            manager.remove_finished(&reader_session_id);
            let _ = app.emit(
                TERMINAL_EVENT,
                TerminalEvent::Exit {
                    session_id: reader_session_id,
                },
            );
        });

        Ok(TerminalSessionInfo { session_id, shell })
    }

    pub fn write(&self, session_id: &str, data: &str) -> Result<(), String> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "终端会话锁已损坏".to_string())?;
        let session = sessions
            .get_mut(session_id)
            .ok_or_else(|| "终端会话不存在或已经退出".to_string())?;
        session
            .writer
            .write_all(data.as_bytes())
            .and_then(|_| session.writer.flush())
            .map_err(|error| format!("终端输入失败: {error}"))
    }

    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| "终端会话锁已损坏".to_string())?;
        let session = sessions
            .get(session_id)
            .ok_or_else(|| "终端会话不存在或已经退出".to_string())?;
        session
            .master
            .resize(pty_size(cols, rows))
            .map_err(|error| format!("调整终端尺寸失败: {error}"))
    }

    pub fn close(&self, session_id: &str) -> Result<(), String> {
        let mut session = self
            .sessions
            .lock()
            .map_err(|_| "终端会话锁已损坏".to_string())?
            .remove(session_id);
        if let Some(session) = session.as_mut() {
            session
                .child
                .kill()
                .map_err(|error| format!("关闭终端失败: {error}"))?;
        }
        Ok(())
    }

    fn remove_finished(&self, session_id: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.remove(session_id);
        }
    }
}

impl Drop for TerminalManager {
    fn drop(&mut self) {
        if let Ok(sessions) = self.sessions.get_mut() {
            for session in sessions.values_mut() {
                let _ = session.child.kill();
            }
        }
    }
}

pub fn open_iterm(cwd: &str) -> Result<(), String> {
    validate_cwd(cwd)?;
    let status = Command::new("/usr/bin/open")
        .args(["-a", "iTerm", cwd])
        .status()
        .map_err(|error| format!("无法打开 iTerm2: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("iTerm2 未安装或无法打开".to_string())
    }
}

fn validate_cwd(cwd: &str) -> Result<(), String> {
    if cwd.trim().is_empty() || !Path::new(cwd).is_dir() {
        return Err("终端工作目录不存在".to_string());
    }
    Ok(())
}

fn login_shell() -> String {
    std::env::var("SHELL")
        .ok()
        .filter(|shell| Path::new(shell).is_absolute() && Path::new(shell).is_file())
        .unwrap_or_else(|| "/bin/zsh".to_string())
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows: rows.max(2),
        cols: cols.max(2),
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn uuid_like_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("terminal-{nanos}-{}", std::process::id())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::mpsc,
        time::{Duration, Instant},
    };

    #[test]
    fn clamps_pty_dimensions() {
        let size = pty_size(0, 1);
        assert_eq!(size.cols, 2);
        assert_eq!(size.rows, 2);
    }

    #[test]
    fn rejects_missing_working_directory() {
        assert!(validate_cwd("/definitely/not/a/real/codex-harness-path").is_err());
    }

    #[test]
    fn interactive_pty_accepts_input_and_returns_output() {
        let home = tempfile::tempdir().expect("creates isolated shell home");
        let pair = native_pty_system()
            .openpty(pty_size(80, 24))
            .expect("creates test pty");
        let mut command = CommandBuilder::new("/bin/sh");
        command.arg("-i");
        command.cwd(home.path());
        command.env("HOME", home.path());
        let mut child = pair
            .slave
            .spawn_command(command)
            .expect("starts test shell");
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().expect("clones pty reader");
        let mut writer = pair.master.take_writer().expect("takes pty writer");
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let mut buffer = [0_u8; 1024];
            while let Ok(length) = reader.read(&mut buffer) {
                if length == 0 {
                    break;
                }
                if sender
                    .send(String::from_utf8_lossy(&buffer[..length]).into_owned())
                    .is_err()
                {
                    break;
                }
            }
        });

        writer
            .write_all(b"printf '\\137\\137HARNESS_PTY_OK\\137\\137\\n'\r")
            .expect("writes command to pty");
        writer.flush().expect("flushes pty input");
        let mut output = String::new();
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let Ok(chunk) = receiver.recv_timeout(remaining) else {
                break;
            };
            output.push_str(&chunk);
            if output.contains("__HARNESS_PTY_OK__") {
                break;
            }
        }
        let _ = child.kill();
        assert!(
            output.contains("__HARNESS_PTY_OK__"),
            "output was {output:?}"
        );
    }
}
