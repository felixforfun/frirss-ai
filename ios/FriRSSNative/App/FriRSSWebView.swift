import SwiftUI
import WebKit

struct FriRSSWebView: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.contentInsetAdjustmentBehavior = .automatic
        webView.load(URLRequest(url: url))
        context.coordinator.webView = webView
        NotificationCenter.default.addObserver(
            context.coordinator,
            selector: #selector(Coordinator.openArticle(_:)),
            name: .openFriRSSArticle,
            object: nil
        )
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        guard webView.url?.host != url.host else { return }
        webView.load(URLRequest(url: url))
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject {
        weak var webView: WKWebView?

        @objc func openArticle(_ notification: Notification) {
            guard let url = notification.object as? URL else { return }
            webView?.load(URLRequest(url: url))
        }

        deinit {
            NotificationCenter.default.removeObserver(self)
        }
    }
}
