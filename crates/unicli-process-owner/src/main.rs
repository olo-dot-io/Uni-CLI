//! @owner crates::unicli-process-owner
//! @does On Windows, join a kill-on-close Job Object before spawning either one explicit command or the configured Node Chrome Native Messaging host selected by the installed executable name.
//! @needs std process/fs/path, serde/serde_json, and Windows Job Object APIs
//! @feeds src/transport/process-owner.ts and src/browser/native-host-install.ts
//! @breaks Spawning before Job assignment creates a race where the child can escape containment; invalid/missing strict native-host config or Job setup fails before child creation.
//! @invariants The wrapper joins its Job before child creation; the Job handle remains open until the command exits; process-owner arguments preserve OsString fidelity; only the exact unicli-browser-native-host executable stem activates the sibling versioned config; report identities are written atomically.
//! @side-effects Creates a Windows Job, reads an optional sibling native-host config, spawns/waits a child with inherited stdio, optionally writes one identity report, and exits with the child code.
//! @test Windows CI exercises the wrapper through Rust parser tests, TypeScript containment tests, and the real Native Messaging framing integration.
//! @stability stable
//! @since 2026-07-16

#[cfg(target_os = "windows")]
fn main() {
    if let Err(error) = windows_main() {
        eprintln!("unicli-process-owner: {error}");
        std::process::exit(70);
    }
}

#[cfg(not(target_os = "windows"))]
fn main() {
    eprintln!("unicli-process-owner is only supported on Windows");
    std::process::exit(78);
}

#[cfg(target_os = "windows")]
fn windows_main() -> Result<(), Box<dyn std::error::Error>> {
    use std::ffi::c_void;
    use std::process::{Command, Stdio};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::GetCurrentProcess;

    let invocation = parse_invocation()?;
    let job = unsafe { CreateJobObjectW(None, windows::core::PCWSTR::null())? };
    let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )?;
        AssignProcessToJobObject(job, GetCurrentProcess())?;
    }

    let mut child = match Command::new(&invocation.command)
        .args(&invocation.args)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => return Err(error.into()),
    };
    if let Some(report_path) = invocation.report_path {
        write_report(&report_path, std::process::id(), child.id())?;
    }
    let status = child.wait()?;
    std::process::exit(status.code().unwrap_or(1));
}

#[cfg(target_os = "windows")]
#[derive(Debug)]
struct Invocation {
    report_path: Option<std::path::PathBuf>,
    command: std::path::PathBuf,
    args: Vec<std::ffi::OsString>,
}

#[cfg(target_os = "windows")]
fn parse_invocation() -> Result<Invocation, Box<dyn std::error::Error>> {
    parse_invocation_from(std::env::current_exe()?, std::env::args_os().skip(1))
}

#[cfg(target_os = "windows")]
fn parse_invocation_from(
    executable_path: std::path::PathBuf,
    mut args: impl Iterator<Item = std::ffi::OsString>,
) -> Result<Invocation, Box<dyn std::error::Error>> {
    if is_native_host_executable(&executable_path) {
        return native_host_invocation(&executable_path);
    }
    let mut report_path = None;
    let first = args.next().ok_or("missing -- command separator")?;
    let separator = if first == "--report" {
        report_path = Some(std::path::PathBuf::from(
            args.next().ok_or("missing --report path")?,
        ));
        args.next().ok_or("missing -- command separator")?
    } else {
        first
    };
    if separator != "--" {
        return Err("expected -- before command".into());
    }
    let command = args.next().ok_or("missing command")?;
    Ok(Invocation {
        report_path,
        command: std::path::PathBuf::from(command),
        args: args.collect(),
    })
}

#[cfg(target_os = "windows")]
fn is_native_host_executable(path: &std::path::Path) -> bool {
    path.file_stem()
        .and_then(std::ffi::OsStr::to_str)
        .is_some_and(|stem| stem.eq_ignore_ascii_case("unicli-browser-native-host"))
}

#[cfg(target_os = "windows")]
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeHostConfig {
    version: u32,
    node_path: std::path::PathBuf,
    entrypoint_path: std::path::PathBuf,
}

#[cfg(target_os = "windows")]
fn native_host_invocation(
    executable_path: &std::path::Path,
) -> Result<Invocation, Box<dyn std::error::Error>> {
    let config_path = executable_path.with_extension("json");
    let encoded = std::fs::read(&config_path)?;
    let config: NativeHostConfig = serde_json::from_slice(&encoded)?;
    if config.version != 1 {
        return Err(format!(
            "unsupported native-host config version {} in {}",
            config.version,
            config_path.display()
        )
        .into());
    }
    validate_native_host_path(&config.node_path, "Node.js runtime")?;
    validate_native_host_path(&config.entrypoint_path, "native-host entrypoint")?;
    Ok(Invocation {
        report_path: None,
        command: config.node_path,
        args: vec![config.entrypoint_path.into_os_string()],
    })
}

#[cfg(target_os = "windows")]
fn validate_native_host_path(
    path: &std::path::Path,
    role: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    if !path.is_absolute() || !path.is_file() {
        return Err(format!("{role} path is not an absolute file: {}", path.display()).into());
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn write_report(
    path: &std::path::Path,
    owner_pid: u32,
    command_pid: u32,
) -> Result<(), Box<dyn std::error::Error>> {
    use std::io::Write;

    let temporary = path.with_extension(format!("{}.tmp", owner_pid));
    let mut file = std::fs::File::create(&temporary)?;
    writeln!(
        file,
        "{{\"version\":1,\"containment\":\"windows-job\",\"owner_pid\":{owner_pid},\"command_pid\":{command_pid}}}"
    )?;
    file.sync_all()?;
    std::fs::rename(temporary, path)?;
    Ok(())
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::sync::atomic::{AtomicU64, Ordering};

    static FIXTURE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn native_host_role_reads_strict_config_and_ignores_chrome_arguments() {
        let fixture = NativeHostFixture::create();
        fixture.write_config(serde_json::json!({
            "version": 1,
            "node_path": fixture.node_path,
            "entrypoint_path": fixture.entrypoint_path,
        }));

        let invocation = parse_invocation_from(
            fixture.launcher_path.clone(),
            [
                OsString::from("chrome-extension://decklegbfaimflikbihddclmbiiaiakg/"),
                OsString::from("--parent-window=0"),
            ]
            .into_iter(),
        )
        .expect("native-host config should produce an invocation");

        assert_eq!(invocation.report_path, None);
        assert_eq!(invocation.command, fixture.node_path);
        assert_eq!(
            invocation.args,
            vec![fixture.entrypoint_path.clone().into_os_string()]
        );
    }

    #[test]
    fn native_host_role_rejects_unknown_config_fields() {
        let fixture = NativeHostFixture::create();
        fixture.write_config(serde_json::json!({
            "version": 1,
            "node_path": fixture.node_path,
            "entrypoint_path": fixture.entrypoint_path,
            "command": "attacker.exe",
        }));

        let error = parse_invocation_from(fixture.launcher_path.clone(), std::iter::empty())
            .expect_err("unknown config fields must fail closed");
        assert!(error.to_string().contains("unknown field"));
    }

    #[test]
    fn process_owner_role_preserves_command_arguments() {
        let executable_path = std::env::current_exe().expect("test executable path");
        let invocation = parse_invocation_from(
            executable_path,
            [
                OsString::from("--report"),
                OsString::from(r"C:\reports\owner.json"),
                OsString::from("--"),
                OsString::from(r"C:\Program Files\node.exe"),
                OsString::from("λ argument"),
            ]
            .into_iter(),
        )
        .expect("process-owner arguments should parse");

        assert_eq!(
            invocation.report_path,
            Some(std::path::PathBuf::from(r"C:\reports\owner.json"))
        );
        assert_eq!(
            invocation.command,
            std::path::PathBuf::from(r"C:\Program Files\node.exe")
        );
        assert_eq!(invocation.args, vec![OsString::from("λ argument")]);
    }

    #[test]
    fn owner_report_atomically_replaces_an_existing_identity() {
        let fixture = NativeHostFixture::create();
        let report_path = fixture.root.join("owner.json");
        std::fs::write(&report_path, b"stale identity").expect("write stale report");

        write_report(&report_path, 41, 42).expect("replace owner report");

        assert_eq!(
            std::fs::read_to_string(report_path).expect("read owner report"),
            "{\"version\":1,\"containment\":\"windows-job\",\"owner_pid\":41,\"command_pid\":42}\n"
        );
    }

    #[derive(Debug)]
    struct NativeHostFixture {
        root: std::path::PathBuf,
        launcher_path: std::path::PathBuf,
        node_path: std::path::PathBuf,
        entrypoint_path: std::path::PathBuf,
    }

    impl NativeHostFixture {
        fn create() -> Self {
            let sequence = FIXTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "unicli-process-owner-{}-{sequence}",
                std::process::id()
            ));
            std::fs::create_dir_all(&root).expect("create fixture root");
            let launcher_path = root.join("unicli-browser-native-host.exe");
            let node_path = root.join("node.exe");
            let entrypoint_path = root.join("native-host-main.js");
            std::fs::write(&node_path, b"node fixture").expect("write node fixture");
            std::fs::write(&entrypoint_path, b"entrypoint fixture")
                .expect("write entrypoint fixture");
            Self {
                root,
                launcher_path,
                node_path,
                entrypoint_path,
            }
        }

        fn write_config(&self, config: serde_json::Value) {
            std::fs::write(
                self.launcher_path.with_extension("json"),
                serde_json::to_vec(&config).expect("encode fixture config"),
            )
            .expect("write fixture config");
        }
    }

    impl Drop for NativeHostFixture {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.root).expect("remove fixture root");
        }
    }
}
