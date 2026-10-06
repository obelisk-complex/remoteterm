<p align="center">
  <a href="https://remoteterm.dev">
	<picture>
		<source media="(prefers-color-scheme: dark)" srcset="./assets/wave-dark.png">
		<source media="(prefers-color-scheme: light)" srcset="./assets/wave-light.png">
		<img alt="RemoteTerm Logo" src="./assets/wave-light.png" width="240">
	</picture>
  </a>
  <br/>
</p>

> **Fork:** This is a fork of [Wave Terminal](https://github.com/wavetermdev/waveterm) optimized for remote development workflows.

# RemoteTerm

<div align="center">

[English](README.md) | [한국어](README.ko.md) | [繁體中文](README.zh-TW.md)

</div>

RemoteTerm is an open-source terminal for macOS, Linux, and Windows. No accounts required.

RemoteTerm supports durable SSH sessions that survive network interruptions and restarts, with automatic reconnection. Edit remote files with a built-in graphical editor and preview files inline without leaving the terminal.

## What's different

This fork is tuned for developers who work on remote machines, with the local app as a thin client.

**Sessions that heal themselves.** Durable SSH sessions survive network drops, laptop sleep/wake, VPN changes, and app restarts. When a connection drops it reconnects automatically.

**Remote work feels local.** Inline images render right in the terminal (Sixel, iTerm2, Kitty). Copy-and-paste screenshots and drag-and-drop files into remote sessions. Review, stage, commit, and push changes on any connected host with the built-in source-control sidebar.

**Your AI agents stay running.** Claude Code, Grok Build, OpenCode, and Pi work in the terminal — durable sessions survive disconnects, irrespective if your local machine is offline and inline images render their output.

**Your SSH config is automatically detected.** `LocalForward` / `RemoteForward` from `~/.ssh/config` are applied automatically — no extra setup.

**Private by default.** Zero telemetry, analytics, and cloud data collection. Always.

![RemoteTerm Screenshot](./assets/wave-screenshot.webp)

## Key Features

- Durable SSH Sessions - Remote terminal sessions survive connection interruptions, network changes, and RemoteTerm restarts with automatic reconnection
- Flexible drag & drop interface to organize terminal blocks, editors, web browsers, and previews
- Built-in editor for editing remote files with syntax highlighting and modern editor features
- Rich file preview system for remote files (markdown, images, video, PDFs, CSVs, directories)
- Quick full-screen toggle for any block - expand terminals, editors, and previews for better visibility, then instantly return to multi-block view
- Command Blocks for isolating and monitoring individual commands
- One-click remote connections with full terminal and file system access
- Secure secret storage using native system backends - store API keys and credentials locally, access them across SSH sessions
- Rich customization including tab themes, terminal styles, and background images
- Powerful `wsh` command system for managing your workspace from the CLI and sharing data between terminal sessions
- Connected file management with `wsh file` - seamlessly copy and sync files between local and remote SSH hosts
- Inline image rendering - display images directly in the terminal using Sixel, iTerm2, or Kitty protocols

## Installation

RemoteTerm works on macOS, Linux, and Windows.

### Minimum requirements

RemoteTerm runs on the following platforms:

- macOS 12 or later (arm64, x64)
- Windows 10 1809 or later (x64)
- Linux based on glibc-2.28 or later (Debian 10, RHEL 8, Ubuntu 20.04, etc.) (arm64, x64)

The WSH helper runs on the following platforms:

- macOS 12 or later (arm64, x64)
- Windows 10 or later (x64)
- Linux Kernel 2.6.32 or later (x64), Linux Kernel 3.1 or later (arm64)

### Upgrading from Wave Terminal

RemoteTerm is a fork of Wave Terminal. If you have any `WAVETERM_*_HOME` environment variables
set in your shell profile from a previous Wave Terminal install, they're still honoured (as
deprecated aliases for the equivalent `REMOTETERM_*_HOME` vars) — your config and data locations
carry over unchanged. These vars only affect where RemoteTerm's own config/data files live; they
do not relocate the app's browser profile (cookies, web-block logins, etc.), which stays at its
normal OS-default location for a regular install either way.

## Building from Source

See [Building RemoteTerm](BUILD.md).

## Contributing

RemoteTerm uses GitHub Issues for issue tracking.

Find more information in our [Contributions Guide](CONTRIBUTING.md), which includes:

- [Ways to contribute](CONTRIBUTING.md#contributing-to-remoteterm)
- [Contribution guidelines](CONTRIBUTING.md#before-you-start)

## License

RemoteTerm is licensed under the Apache-2.0 License. For more information on our dependencies, see [here](./ACKNOWLEDGEMENTS.md).
