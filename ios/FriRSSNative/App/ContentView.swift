import SwiftUI
import WebKit

struct ContentView: View {
    @EnvironmentObject private var settings: AppSettings
    @State private var editingURL = ""
    @State private var showSettings = false

    var body: some View {
        Group {
            if let url = settings.normalizedURL {
                FriRSSWebView(url: url)
                    .ignoresSafeArea(edges: .bottom)
                    .onOpenURL { incoming in
                        guard incoming.scheme == "frirss",
                              incoming.host == "article",
                              let target = URLComponents(string: incoming.absoluteString)?
                                .queryItems?.first(where: { $0.name == "url" })?.value,
                              let articleURL = URL(string: target),
                              articleURL.host == url.host else { return }
                        NotificationCenter.default.post(
                            name: .openFriRSSArticle,
                            object: articleURL
                        )
                    }
                    .toolbar {
                        ToolbarItem(placement: .topBarTrailing) {
                            Button { showSettings = true } label: {
                                Image(systemName: "gearshape")
                            }
                        }
                    }
            } else {
                ContentUnavailableView {
                    Label("Connect FriRSS", systemImage: "newspaper")
                } description: {
                    Text("Enter the URL of your existing FriRSS instance.")
                } actions: {
                    TextField("https://frirss.example.com", text: $editingURL)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()
                        .textFieldStyle(.roundedBorder)
                        .padding(.horizontal)
                    Button("Open FriRSS") {
                        settings.baseURL = editingURL
                    }
                    .buttonStyle(.borderedProminent)
                }
            }
        }
        .sheet(isPresented: $showSettings) {
            NavigationStack {
                Form {
                    Section("FriRSS server") {
                        TextField("https://frirss.example.com", text: $editingURL)
                            .textInputAutocapitalization(.never)
                            .keyboardType(.URL)
                            .autocorrectionDisabled()
                        Button("Save") {
                            settings.baseURL = editingURL
                            showSettings = false
                        }
                    }
                }
                .navigationTitle("Settings")
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Done") { showSettings = false }
                    }
                }
            }
            .onAppear { editingURL = settings.baseURL }
        }
        .onAppear { editingURL = settings.baseURL }
    }
}

extension Notification.Name {
    static let openFriRSSArticle = Notification.Name("openFriRSSArticle")
}
