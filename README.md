# Resource Governor

**Free & open-source bandwidth, CPU, and memory governor for Windows.**

Resource Governor combines [Bandwidth Governor](https://github.com/Nimba-Solutions/Bandwidth-Governor) and [Process Governor](https://github.com/Nimba-Solutions/Process-Governor) into one unified app for complete system resource control.

## Features

### Bandwidth Limiting (QoS)
- **Global & per-app bandwidth limiting** via Windows QoS policies (upload and download)
- **One-click presets** — Upload-only (Light/Medium/Strict) and Balanced (Light/Medium/Strict)
- **Quick per-app upload limits** for common processes (node.exe, git.exe, ssh.exe, etc.)
- **Custom rules** with configurable upload/download limits per application
- **Configure for Claude** — auto-detect upload speed and cap Claude-related processes
- **Speed test** via Cloudflare endpoints (download + upload)
- **Live bandwidth monitor** showing real-time upload/download rates
- **Master on/off toggle** for all bandwidth policies
- **Auto-apply policies on startup**

### CPU & Memory Limiting
- **CPU limiting via processor affinity** — restrict which cores a process can use
- **Memory limiting via MaxWorkingSet** — cap working set size per process
- **Process rules** with automatic re-apply every 5 seconds (catches new instances)
- **One-click presets** — Claude Code Light/Strict, Build Tools, Background Apps
- **Process explorer** — view top 50 processes by CPU time with memory usage
- **Kill process** directly from the dashboard
- **System stats** — real-time CPU%, memory usage, and core count

### Shared Features
- **Unified dashboard** with tabbed interface (Bandwidth, Process, Launchers, Prompts)
- **System tray** with status indicators and quick actions
- **Claude Quick Launch** — save project folders, launch Claude Code with one click
- **Prompt Backlog** — queue, prioritize, tag, and track prompts for Claude sessions
- **Auto-start on Windows login** via registry
- **Admin elevation** — self-elevate to administrator when needed
- **Dark themed UI** with deep blue/indigo color scheme

## Installation

### Portable (Recommended)
1. Download `ResourceGovernor-1.0.0.exe` from [Releases](https://github.com/Nimba-Solutions/Resource-Governor/releases)
2. Run it — no installation needed
3. Right-click the system tray icon to access the dashboard

### From Source
```bash
git clone https://github.com/Nimba-Solutions/Resource-Governor.git
cd Resource-Governor
npm install
npm start
```

## Requirements

- Windows 10/11
- Administrator privileges (for QoS policies, CPU affinity, and memory limits)

## How It Works

### Bandwidth
Uses Windows **NetQoS policies** (`New-NetQosPolicy` / `Remove-NetQosPolicy`) to throttle upload and download bandwidth per-application or globally. Policies are applied to the ActiveStore and persist across app restarts.

### CPU
Sets **processor affinity masks** to restrict which CPU cores a process can use, and lowers process priority to `BelowNormal`. Rules re-apply every 5 seconds to catch newly spawned processes.

### Memory
Sets **MaxWorkingSet** on target processes to cap their physical memory usage.

## License

[BSL 1.1](LICENSE.md) — Cloud Nimbus LLC

## Links

- **Website:** [cloudnimbusllc.com](https://cloudnimbusllc.com)
- **GitHub:** [github.com/Nimba-Solutions/Resource-Governor](https://github.com/Nimba-Solutions/Resource-Governor)
