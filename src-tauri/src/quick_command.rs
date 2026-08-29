use serde::Serialize;
use std::{fs::File, process::Stdio, time::Duration};
use tokio::{process::Command, time::timeout};

const VPN_BIN: &str = "/opt/cisco/secureclient/bin/vpn";
const VPN_RESPONSE: &str = "/opt/cisco/secureclient/bin/response.txt";
const SMC_BIN: &str = "/usr/local/bin/smc";
const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickCommandResult {
    pub command_id: String,
    pub success: bool,
    pub message: String,
}

pub async fn run(command_id: &str) -> Result<QuickCommandResult, String> {
    match command_id {
        "vpn-on" => run_vpn_on().await,
        "smc-login" => run_smc_login(command_id, &[]).await,
        "smc-login-test" => run_smc_login(command_id, &["--test"]).await,
        _ => Err(format!("不支持的快捷命令：{command_id}")),
    }
}

async fn run_vpn_on() -> Result<QuickCommandResult, String> {
    let response =
        File::open(VPN_RESPONSE).map_err(|error| format!("无法读取 VPN 响应文件: {error}"))?;
    let _ = run_process(VPN_BIN, &["-s"], Some(Stdio::from(response))).await?;
    let state = run_process(VPN_BIN, &["state"], None).await?;
    let output = combined_output(&state);
    let success = vpn_state_connected(&output);
    Ok(QuickCommandResult {
        command_id: "vpn-on".to_string(),
        success,
        message: if success {
            "VPN 已连接".to_string()
        } else {
            "未检测到 VPN Connected 状态".to_string()
        },
    })
}

async fn run_smc_login(command_id: &str, args: &[&str]) -> Result<QuickCommandResult, String> {
    let output = run_process(SMC_BIN, &[&["login"], args].concat(), None).await?;
    let success = output.status.success();
    Ok(QuickCommandResult {
        command_id: command_id.to_string(),
        success,
        message: if success {
            "命令执行完成".to_string()
        } else {
            format!("命令执行失败（{}）", exit_label(&output.status))
        },
    })
}

async fn run_process(
    program: &str,
    args: &[&str],
    stdin: Option<Stdio>,
) -> Result<std::process::Output, String> {
    let mut command = Command::new(program);
    command.args(args).kill_on_drop(true);
    if let Some(stdin) = stdin {
        command.stdin(stdin);
    }
    timeout(COMMAND_TIMEOUT, command.output())
        .await
        .map_err(|_| format!("快捷命令执行超时：{program}"))?
        .map_err(|error| format!("无法启动快捷命令 {program}: {error}"))
}

fn combined_output(output: &std::process::Output) -> String {
    format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

fn vpn_state_connected(output: &str) -> bool {
    output
        .lines()
        .any(|line| line.to_ascii_lowercase().contains("state: connected"))
}

fn exit_label(status: &std::process::ExitStatus) -> String {
    status
        .code()
        .map(|code| format!("退出码 {code}"))
        .unwrap_or_else(|| "进程异常结束".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_cisco_connected_state() {
        assert!(vpn_state_connected("  >> state: Connected\nVPN>"));
        assert!(!vpn_state_connected("  >> state: Disconnected\nVPN>"));
    }
}
