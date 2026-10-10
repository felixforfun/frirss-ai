# FriRSS Native iOS wrapper + widget

This is an experimental native iOS shell for the existing self-hosted FriRSS web app.

## What is included

- SwiftUI app that opens your existing FriRSS instance in a WKWebView.
- Server URL configuration screen.
- WidgetKit widget in small, medium, and large sizes.
- Per-headline links, with the intent that links open the matching article in FriRSS.

## Current limitations / next steps

The widget currently expects a JSON endpoint at `/api/widget/articles`. That endpoint does **not** exist in FriRSS yet; implement it in the FriRSS server before expecting live widget data. Do not expose FreshRSS credentials to the widget. Prefer a dedicated, authenticated, read-only endpoint that returns only unread article metadata and FriRSS article URLs.

The placeholder host in `Widget/FriRSSWidget.swift` must be replaced with your instance URL or, preferably, changed to a configurable secure design. Cloudflare Access authentication needs a dedicated plan because the widget's URLSession does not automatically share the app's WebView login session.

Deep links need to be aligned with the actual FriRSS article route once verified. A widget article should link to the exact FriRSS article URL, not the publisher URL.

## Build

Requires macOS, Xcode, and XcodeGen.

```sh
brew install xcodegen
cd ios/FriRSSNative
xcodegen generate
open FriRSSNative.xcodeproj
```

Choose your Personal Team under Signing & Capabilities, connect an iPhone, and run the FriRSS target. Widget signing and App Group support must be tested with the free Personal Team; Apple provisioning restrictions may limit the final widget setup.
