//! @owner crates::unicli-process-owner
//! @does On Windows, join a kill-on-close Job Object before spawning one command so that its complete descendant tree dies with this wrapper.
//! @needs std process/fs/path and Windows Job Object APIs
//! @feeds src/transport/process-owner.ts
//! @breaks Spawning before Job assignment creates a race where the child can escape containment; continuing after Job setup failure would falsely claim containment.
//! @invariants The wrapper joins its Job before child creation; the Job handle is non-inheritable and remains open until the command exits; report identities are written atomically.
//! @side-effects Creates a Windows Job, spawns/waits a child, optionally writes one identity report, and exits with the child code.
//! @test Windows CI exercises the wrapper through TypeScript containment and managed-browser lifecycle tests.
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
struct Invocation {
    report_path: Option<std::path::PathBuf>,
    command: String,
    args: Vec<String>,
}

#[cfg(target_os = "windows")]
fn parse_invocation() -> Result<Invocation, Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
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
        command,
        args: args.collect(),
    })
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
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    std::fs::rename(temporary, path)?;
    Ok(())
}
