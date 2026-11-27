//! Spawn long-lived helper daemons without making Harness their "responsible" app.
//!
//! macOS attributes privacy (TCC) prompts to the responsible process, which is
//! inherited across fork/exec and outlives the parent. A daemon started by one
//! Harness bundle would otherwise keep prompting in that bundle's name even after
//! a release renamed it to `Codex Harness.app.backup-*`. Disclaiming at spawn
//! makes the daemon responsible for itself, so releases never need to restart it.

use std::{
    env,
    ffi::OsString,
    fs::File,
    io,
    path::{Path, PathBuf},
    process::Output,
};

pub struct DetachedCommand {
    program: PathBuf,
    args: Vec<OsString>,
    env: Vec<(OsString, OsString)>,
    cwd: Option<PathBuf>,
    open_file_soft_limit: Option<u64>,
}

impl DetachedCommand {
    /// Starts from the current process environment, like `std::process::Command`.
    pub fn new(program: impl AsRef<Path>) -> Self {
        Self {
            program: program.as_ref().to_path_buf(),
            args: Vec::new(),
            env: env::vars_os().collect(),
            cwd: None,
            open_file_soft_limit: None,
        }
    }

    pub fn arg(&mut self, arg: impl Into<OsString>) -> &mut Self {
        self.args.push(arg.into());
        self
    }

    pub fn args<I, S>(&mut self, args: I) -> &mut Self
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        self.args.extend(args.into_iter().map(Into::into));
        self
    }

    pub fn env(&mut self, key: impl Into<OsString>, value: impl Into<OsString>) -> &mut Self {
        let key = key.into();
        self.env.retain(|(existing, _)| existing != &key);
        self.env.push((key, value.into()));
        self
    }

    pub fn env_clear(&mut self) -> &mut Self {
        self.env.clear();
        self
    }

    pub fn current_dir(&mut self, dir: impl AsRef<Path>) -> &mut Self {
        self.cwd = Some(dir.as_ref().to_path_buf());
        self
    }

    /// Applies `RLIMIT_NOFILE` soft limit `min(hard, limit)` to the child only.
    pub fn open_file_soft_limit(&mut self, limit: u64) -> &mut Self {
        self.open_file_soft_limit = Some(limit);
        self
    }

    /// Runs to completion and captures stdout/stderr through anonymous temp
    /// files, so a grandchild daemon that keeps stdio open cannot block us.
    pub fn output(&self) -> io::Result<Output> {
        use std::io::{Read, Seek, SeekFrom};
        let mut stdout = tempfile::tempfile()?;
        let mut stderr = tempfile::tempfile()?;
        let pid = self.spawn_with(&stdout, &stderr)?;
        let status = wait(pid)?;
        let read = |file: &mut File| -> io::Result<Vec<u8>> {
            let mut bytes = Vec::new();
            file.seek(SeekFrom::Start(0))?;
            file.read_to_end(&mut bytes)?;
            Ok(bytes)
        };
        Ok(Output {
            status,
            stdout: read(&mut stdout)?,
            stderr: read(&mut stderr)?,
        })
    }

    /// Starts without waiting; stdout and stderr both go to `log`. A background
    /// thread reaps the child when it exits.
    pub fn spawn_logged(&self, log: &File) -> io::Result<u32> {
        let pid = self.spawn_with(log, log)?;
        std::thread::spawn(move || {
            let _ = wait(pid);
        });
        Ok(pid as u32)
    }

    /// Program and argv actually executed, including the optional rlimit shim.
    fn argv(&self) -> (PathBuf, Vec<OsString>) {
        let Some(limit) = self.open_file_soft_limit.map(|limit| soft_limit_target(limit)) else {
            let mut argv = vec![self.program.clone().into_os_string()];
            argv.extend(self.args.iter().cloned());
            return (self.program.clone(), argv);
        };
        // posix_spawn has no rlimit attribute; a shell shim applies it and
        // `exec`s the real program, which keeps the disclaimed responsibility.
        let mut argv: Vec<OsString> = vec![
            "/bin/sh".into(),
            "-c".into(),
            r#"ulimit -S -n "$0" && exec "$@""#.into(),
            limit.to_string().into(),
            self.program.clone().into_os_string(),
        ];
        argv.extend(self.args.iter().cloned());
        (PathBuf::from("/bin/sh"), argv)
    }
}

fn soft_limit_target(limit: u64) -> u64 {
    let mut current = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut current) } != 0 {
        return limit;
    }
    (current.rlim_max as u64).min(limit)
}

#[cfg(target_os = "macos")]
impl DetachedCommand {
    fn spawn_with(&self, stdout: &File, stderr: &File) -> io::Result<libc::pid_t> {
        use std::{
            ffi::CString,
            os::{fd::AsRawFd, unix::ffi::OsStrExt},
            ptr,
        };

        let c_string = |bytes: &[u8]| {
            CString::new(bytes).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "参数包含 NUL"))
        };
        let (program, argv) = self.argv();
        let program = c_string(program.as_os_str().as_bytes())?;
        let argv = argv
            .iter()
            .map(|arg| c_string(arg.as_bytes()))
            .collect::<io::Result<Vec<_>>>()?;
        let envp = self
            .env
            .iter()
            .map(|(key, value)| {
                let mut entry = key.as_bytes().to_vec();
                entry.push(b'=');
                entry.extend_from_slice(value.as_bytes());
                c_string(&entry)
            })
            .collect::<io::Result<Vec<_>>>()?;
        let mut argv_ptrs: Vec<*mut libc::c_char> =
            argv.iter().map(|arg| arg.as_ptr() as *mut _).collect();
        argv_ptrs.push(ptr::null_mut());
        let mut envp_ptrs: Vec<*mut libc::c_char> =
            envp.iter().map(|entry| entry.as_ptr() as *mut _).collect();
        envp_ptrs.push(ptr::null_mut());
        let cwd = self
            .cwd
            .as_ref()
            .map(|dir| c_string(dir.as_os_str().as_bytes()))
            .transpose()?;
        let dev_null = c_string(b"/dev/null")?;

        let check = |code: libc::c_int| {
            if code == 0 {
                Ok(())
            } else {
                Err(io::Error::from_raw_os_error(code))
            }
        };
        unsafe {
            let mut attr: libc::posix_spawnattr_t = ptr::null_mut();
            check(libc::posix_spawnattr_init(&mut attr))?;
            let mut actions: libc::posix_spawn_file_actions_t = ptr::null_mut();
            if let Err(error) = check(libc::posix_spawn_file_actions_init(&mut actions)) {
                libc::posix_spawnattr_destroy(&mut attr);
                return Err(error);
            }
            let result = (|| {
                // Close every inherited descriptor except the stdio set up below,
                // and undo Rust's SIGPIPE ignore plus any blocked signals.
                check(libc::posix_spawnattr_setflags(
                    &mut attr,
                    (libc::POSIX_SPAWN_CLOEXEC_DEFAULT
                        | libc::POSIX_SPAWN_SETSIGDEF
                        | libc::POSIX_SPAWN_SETSIGMASK) as libc::c_short,
                ))?;
                let mut empty: libc::sigset_t = std::mem::zeroed();
                libc::sigemptyset(&mut empty);
                check(libc::posix_spawnattr_setsigmask(&mut attr, &empty))?;
                let mut defaults: libc::sigset_t = std::mem::zeroed();
                libc::sigemptyset(&mut defaults);
                libc::sigaddset(&mut defaults, libc::SIGPIPE);
                check(libc::posix_spawnattr_setsigdefault(&mut attr, &defaults))?;
                disclaim_responsibility(&mut attr);

                check(libc::posix_spawn_file_actions_addopen(
                    &mut actions,
                    0,
                    dev_null.as_ptr(),
                    libc::O_RDONLY,
                    0,
                ))?;
                check(libc::posix_spawn_file_actions_adddup2(
                    &mut actions,
                    stdout.as_raw_fd(),
                    1,
                ))?;
                check(libc::posix_spawn_file_actions_adddup2(
                    &mut actions,
                    stderr.as_raw_fd(),
                    2,
                ))?;
                if let Some(cwd) = &cwd {
                    check(posix_spawn_file_actions_addchdir_np(
                        &mut actions,
                        cwd.as_ptr(),
                    ))?;
                }
                let mut pid: libc::pid_t = 0;
                check(libc::posix_spawn(
                    &mut pid,
                    program.as_ptr(),
                    &actions,
                    &attr,
                    argv_ptrs.as_ptr(),
                    envp_ptrs.as_ptr(),
                ))?;
                Ok(pid)
            })();
            libc::posix_spawn_file_actions_destroy(&mut actions);
            libc::posix_spawnattr_destroy(&mut attr);
            result
        }
    }
}

// macOS 10.15+; not exposed by the locked libc version.
#[cfg(target_os = "macos")]
extern "C" {
    fn posix_spawn_file_actions_addchdir_np(
        actions: *mut libc::posix_spawn_file_actions_t,
        path: *const libc::c_char,
    ) -> libc::c_int;
}

/// `responsibility_spawnattrs_setdisclaim` is a private libsystem symbol (used by
/// Terminal, iTerm2, Chromium). Resolve it at runtime and silently skip if absent.
#[cfg(target_os = "macos")]
unsafe fn disclaim_responsibility(attr: &mut libc::posix_spawnattr_t) {
    type SetDisclaim = unsafe extern "C" fn(*mut libc::posix_spawnattr_t, libc::c_int) -> libc::c_int;
    let symbol = libc::dlsym(
        libc::RTLD_DEFAULT,
        c"responsibility_spawnattrs_setdisclaim".as_ptr(),
    );
    if !symbol.is_null() {
        let set_disclaim: SetDisclaim = std::mem::transmute(symbol);
        set_disclaim(attr, 1);
    }
}

#[cfg(not(target_os = "macos"))]
impl DetachedCommand {
    fn spawn_with(&self, stdout: &File, stderr: &File) -> io::Result<libc::pid_t> {
        let (program, argv) = self.argv();
        let mut command = std::process::Command::new(program);
        command
            .args(&argv[1..])
            .env_clear()
            .envs(self.env.iter().map(|(key, value)| (key, value)))
            .stdin(std::process::Stdio::null())
            .stdout(stdout.try_clone()?)
            .stderr(stderr.try_clone()?);
        if let Some(cwd) = &self.cwd {
            command.current_dir(cwd);
        }
        let child = command.spawn()?;
        Ok(child.id() as libc::pid_t)
    }
}

fn wait(pid: libc::pid_t) -> io::Result<std::process::ExitStatus> {
    use std::os::unix::process::ExitStatusExt;
    let mut status = 0;
    loop {
        if unsafe { libc::waitpid(pid, &mut status, 0) } == pid {
            return Ok(std::process::ExitStatus::from_raw(status));
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn captures_output_status_env_and_cwd() {
        let dir = tempfile::tempdir().unwrap();
        let mut command = DetachedCommand::new("/bin/sh");
        command
            .args(["-c", r#"printf '%s|%s|%s' "$FOO" "$PWD" "$UNSET_ME"; echo oops >&2; exit 3"#])
            .env_clear()
            .env("FOO", "bar")
            .env("UNSET_ME", "first")
            .env("UNSET_ME", "second")
            .current_dir(dir.path());
        let output = command.output().unwrap();
        assert_eq!(output.status.code(), Some(3));
        let cwd = std::fs::canonicalize(dir.path()).unwrap();
        assert_eq!(
            String::from_utf8_lossy(&output.stdout),
            format!("bar|{}|second", cwd.display())
        );
        assert_eq!(String::from_utf8_lossy(&output.stderr), "oops\n");
    }

    #[test]
    fn applies_open_file_soft_limit_only_to_child() {
        let soft = || {
            let mut limit = libc::rlimit {
                rlim_cur: 0,
                rlim_max: 0,
            };
            assert_eq!(unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) }, 0);
            limit.rlim_cur
        };
        let before = soft();
        let mut command = DetachedCommand::new("/bin/sh");
        command.args(["-c", "ulimit -S -n"]).open_file_soft_limit(321);
        let output = command.output().unwrap();
        assert!(output.status.success(), "{:?}", output);
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "321");
        assert_eq!(soft(), before);
    }

    #[test]
    fn grandchild_holding_stdio_does_not_block_output() {
        let mut command = DetachedCommand::new("/bin/sh");
        command.args(["-c", "sleep 5 & echo started"]);
        let started = std::time::Instant::now();
        let output = command.output().unwrap();
        assert!(started.elapsed() < std::time::Duration::from_secs(3));
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "started");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn spawned_child_is_responsible_for_itself() {
        type GetResponsible = unsafe extern "C" fn(libc::pid_t) -> libc::pid_t;
        let symbol = unsafe {
            libc::dlsym(
                libc::RTLD_DEFAULT,
                c"responsibility_get_pid_responsible_for_pid".as_ptr(),
            )
        };
        if symbol.is_null() {
            return;
        }
        let responsible: GetResponsible = unsafe { std::mem::transmute(symbol) };
        let log = tempfile::tempfile().unwrap();
        let pid = DetachedCommand::new("/bin/sleep")
            .arg("2")
            .spawn_logged(&log)
            .unwrap() as libc::pid_t;
        assert_eq!(unsafe { responsible(pid) }, pid);
        unsafe { libc::kill(pid, libc::SIGTERM) };
    }
}
