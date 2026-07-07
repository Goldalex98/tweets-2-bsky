# Tweets-2-Bsky macOS App

This is a native macOS dashboard client for `tweets-2-bsky`.

It connects directly to your existing server API (local LAN or Tailscale), lets you sign in with your normal dashboard username/password, and manages the same backend actions from a native app UI.

## What it supports

- Server host/port configuration (including Tailscale IPs)
- Sign in / first-user registration
- Dashboard overview and status polling
- Account mapping CRUD (create, edit, delete)
- Backfill queue actions (queue, cancel, clear-all)
- Mapping actions (sync profile, pull Twitter bio, bridge, bot-label bulk actions)
- Group management (create, rename, delete)
- Posts and activity views, including local search
- Settings for Twitter config, AI config, import/export config, updates
- Admin user management and own account security changes

## Open in Xcode

1. Open `macos-dashboard/Package.swift` in Xcode.
2. Select the `Tweets2BskyMac` scheme.
3. Run the app.

If `xcodebuild` or `xcrun` says Command Line Tools are active instead of full Xcode, run:

```bash
sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer
```

## Run from terminal

From `macos-dashboard`:

```bash
DEVELOPER_DIR="/Applications/Xcode.app/Contents/Developer" xcrun swift build
DEVELOPER_DIR="/Applications/Xcode.app/Contents/Developer" xcrun swift run Tweets2BskyMac
```

## Tests

```bash
DEVELOPER_DIR="/Applications/Xcode.app/Contents/Developer" xcrun swift test
```

## Tailscale usage

In the app login screen:

- Host: your server's Tailscale IP (example: `100.x.y.z`)
- Port: your dashboard port (default `3000`)
- HTTPS: enable only if your server endpoint is served over HTTPS

Then sign in with your existing dashboard username/email + password.
