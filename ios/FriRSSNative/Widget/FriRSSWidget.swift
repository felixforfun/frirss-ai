import WidgetKit
import SwiftUI

// Widget data contract. The endpoint should return:
// { "unreadCount": 12, "articles": [
//   { "id": "entry-id", "title": "Headline", "feedTitle": "Source",
//     "publishedAt": "2026-10-09T17:30:00Z", "articleURL": "https://frirss.example.com/..." }
// ] }
// Keep this endpoint authenticated; do not embed FreshRSS credentials in the widget.
private let widgetFeedURL = URL(string: "https://YOUR-FRIRSS-HOST.example/api/widget/articles")!

struct WidgetArticle: Decodable, Identifiable {
    let id: String
    let title: String
    let feedTitle: String
    let publishedAt: Date?
    let articleURL: URL
}

struct WidgetPayload: Decodable {
    let unreadCount: Int
    let articles: [WidgetArticle]
}

struct FriRSSEntry: TimelineEntry {
    let date: Date
    let unreadCount: Int
    let articles: [WidgetArticle]
}

struct FriRSSProvider: TimelineProvider {
    func placeholder(in context: Context) -> FriRSSEntry {
        FriRSSEntry(date: .now, unreadCount: 8, articles: [
            WidgetArticle(id: "1", title: "Example article headline", feedTitle: "Example source", publishedAt: .now, articleURL: URL(string: "https://example.com")!)
        ])
    }

    func getSnapshot(in context: Context, completion: @escaping (FriRSSEntry) -> Void) {
        if context.isPreview {
            completion(placeholder(in: context))
        } else {
            load(completion: completion)
        }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<FriRSSEntry>) -> Void) {
        load { entry in
            completion(Timeline(entries: [entry], policy: .after(.now.addingTimeInterval(30 * 60))))
        }
    }

    private func load(completion: @escaping (FriRSSEntry) -> Void) {
        URLSession.shared.dataTask(with: widgetFeedURL) { data, _, error in
            guard error == nil, let data,
                  let payload = try? JSONDecoder.widgetDecoder.decode(WidgetPayload.self, from: data) else {
                completion(FriRSSEntry(date: .now, unreadCount: 0, articles: []))
                return
            }
            completion(FriRSSEntry(date: .now, unreadCount: payload.unreadCount, articles: payload.articles))
        }.resume()
    }
}

private extension JSONDecoder {
    static var widgetDecoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}

struct FriRSSWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: FriRSSEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("FriRSS").font(.headline)
                Spacer()
                Text("\(entry.unreadCount) unread")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            if entry.articles.isEmpty {
                Text("No articles available")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                Spacer()
            } else {
                ForEach(Array(entry.articles.prefix(family == .systemSmall ? 2 : family == .systemMedium ? 4 : 7))) { article in
                    Link(destination: article.articleURL) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(article.title)
                                .font(.subheadline.weight(.medium))
                                .lineLimit(2)
                                .multilineTextAlignment(.leading)
                            HStack {
                                Text(article.feedTitle).lineLimit(1)
                                Spacer(minLength: 4)
                                if let publishedAt = article.publishedAt {
                                    Text(publishedAt, style: .relative)
                                        .lineLimit(1)
                                }
                            }
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        }
                    }
                    if article.id != entry.articles.prefix(family == .systemSmall ? 2 : family == .systemMedium ? 4 : 7).last?.id {
                        Divider()
                    }
                }
                Spacer(minLength: 0)
            }
        }
        .padding()
        .containerBackground(.background, for: .widget)
    }
}

@main
struct FriRSSWidget: Widget {
    let kind = "FriRSSWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: FriRSSProvider()) { entry in
            FriRSSWidgetView(entry: entry)
        }
        .configurationDisplayName("FriRSS headlines")
        .description("Unread articles from your FriRSS reader.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}
