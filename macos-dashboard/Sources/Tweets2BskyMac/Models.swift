import Foundation

struct EmptyResponse: Decodable {}

struct BootstrapStatus: Decodable {
    let bootstrapOpen: Bool
}

struct LoginResponse: Decodable {
    let token: String
    let isAdmin: Bool?
}

struct UserPermissions: Codable {
    var viewAllMappings: Bool
    var manageOwnMappings: Bool
    var manageAllMappings: Bool
    var manageGroups: Bool
    var queueBackfills: Bool
    var runNow: Bool

    static let `default` = UserPermissions(
        viewAllMappings: false,
        manageOwnMappings: true,
        manageAllMappings: false,
        manageGroups: false,
        queueBackfills: true,
        runNow: true
    )
}

struct AuthUser: Codable {
    let id: String
    let username: String?
    let email: String?
    let isAdmin: Bool
    let permissions: UserPermissions
}

struct AccountMapping: Codable, Identifiable {
    let id: String
    var twitterUsernames: [String]
    var bskyIdentifier: String
    var bskyPassword: String?
    var bskyServiceUrl: String?
    var enabled: Bool
    var owner: String?
    var groupName: String?
    var groupEmoji: String?
    var createdByUserId: String?
    var createdByLabel: String?
    var profileSyncSourceUsername: String?
    var hasBotLabel: Bool?
}

struct AccountGroup: Codable, Hashable {
    let name: String
    let emoji: String?
}

struct PendingBackfill: Codable, Identifiable {
    let id: String
    let limit: Int?
    let queuedAt: Int
    let sequence: Int
    let requestId: String
    let position: Int
}

struct StatusState: Codable {
    let state: String
    let currentAccount: String?
    let processedCount: Int?
    let totalCount: Int?
    let message: String?
    let backfillMappingId: String?
    let backfillRequestId: String?
    let lastUpdate: Int
}

struct StatusResponse: Codable {
    let lastCheckTime: Int
    let nextCheckTime: Int
    let nextCheckMinutes: Int
    let checkIntervalMinutes: Int
    let pendingBackfills: [PendingBackfill]
    let currentStatus: StatusState
}

struct ActivityLog: Codable, Identifiable {
    var id: String { "\(twitter_id)-\(created_at ?? "")" }

    let twitter_id: String
    let twitter_username: String
    let bsky_identifier: String
    let tweet_text: String?
    let bsky_uri: String?
    let status: String
    let created_at: String?
}

struct EnrichedAuthor: Codable {
    let did: String?
    let handle: String
    let displayName: String?
    let avatar: String?
}

struct EnrichedStats: Codable {
    let likes: Int
    let reposts: Int
    let replies: Int
    let quotes: Int
    let engagement: Int
}

struct EnrichedPostMedia: Codable, Identifiable {
    var id: String { "\(type)-\(url ?? thumb ?? UUID().uuidString)" }

    let type: String
    let url: String?
    let thumb: String?
    let alt: String?
    let width: Int?
    let height: Int?
    let title: String?
    let description: String?
}

struct EnrichedPost: Codable, Identifiable {
    var id: String { bskyUri }

    let bskyUri: String
    let bskyCid: String?
    let bskyIdentifier: String
    let twitterId: String
    let twitterUsername: String
    let twitterUrl: String?
    let postUrl: String?
    let createdAt: String?
    let text: String
    let author: EnrichedAuthor
    let stats: EnrichedStats
    let media: [EnrichedPostMedia]
}

struct LocalPostSearchResult: Codable, Identifiable {
    var id: String { "\(twitterId)-\(bskyUri ?? "")" }

    let twitterId: String
    let twitterUsername: String
    let bskyIdentifier: String
    let tweetText: String?
    let bskyUri: String?
    let bskyCid: String?
    let createdAt: String?
    let postUrl: String?
    let twitterUrl: String?
    let score: Double
}

struct RuntimeVersionInfo: Codable {
    let version: String
    let commit: String?
    let branch: String?
    let startedAt: Int
}

struct UpdateStatusInfo: Codable {
    let running: Bool
    let pid: Int?
    let startedAt: Int?
    let startedBy: String?
    let finishedAt: Int?
    let exitCode: Int?
    let signal: String?
    let logFile: String?
    let logTail: [String]?
}

struct TwitterConfig: Codable {
    var authToken: String
    var ct0: String
    var backupAuthToken: String?
    var backupCt0: String?

    static let empty = TwitterConfig(authToken: "", ct0: "", backupAuthToken: "", backupCt0: "")
}

struct AIConfig: Codable {
    var provider: String
    var apiKey: String?
    var model: String?
    var baseUrl: String?

    static let empty = AIConfig(provider: "gemini", apiKey: "", model: "", baseUrl: "")
}

struct ManagedUser: Codable, Identifiable {
    let id: String
    let username: String?
    let email: String?
    let role: String
    let isAdmin: Bool
    let permissions: UserPermissions
    let createdAt: String
    let updatedAt: String
    let mappingCount: Int
    let activeMappingCount: Int
    let mappings: [AccountMapping]
}

struct TwitterMirrorProfile: Codable {
    let username: String
    let profileUrl: String
    let name: String?
    let biography: String?
    let avatarUrl: String?
    let bannerUrl: String?
    let mirroredDisplayName: String
    let mirroredDescription: String
}

struct BlueskyCredentialValidation: Codable {
    let did: String
    let handle: String
    let email: String?
    let emailConfirmed: Bool
    let serviceUrl: String
    let settingsUrl: String
}

struct MirrorProfileSyncResult: Codable {
    let success: Bool
    let skipped: Bool?
    let warnings: [String]?
    let sourceTwitterUsername: String?
    let mapping: AccountMapping?
}

struct BulkBotLabelAllResult: Codable {
    let success: Bool
    let total: Int
    let labeled: Int
    let alreadyLabeled: Int
    let failed: Int
}

struct BulkAppendBotNameAllResult: Codable {
    let success: Bool
    let total: Int
    let appended: Int
    let alreadyAppended: Int
    let failed: Int
}

struct FediverseBridgeStatusView: Codable {
    let bridged: Bool
    let checkedAt: String
    let error: String?
}

struct APIMessageResponse: Codable {
    let success: Bool?
    let message: String?
    let error: String?
    let token: String?
    let me: AuthUser?
}

struct ServerConfig: Codable {
    var host: String
    var port: String
    var useHTTPS: Bool

    static let `default` = ServerConfig(host: "127.0.0.1", port: "3000", useHTTPS: false)

    var normalizedPort: String {
        let trimmed = port.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "3000" : trimmed
    }

    var normalizedHost: String {
        let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "127.0.0.1" : trimmed
    }

    var baseURLString: String {
        let scheme = useHTTPS ? "https" : "http"
        return "\(scheme)://\(normalizedHost):\(normalizedPort)"
    }
}

struct MappingDraft {
    var owner: String = ""
    var twitterUsernames: String = ""
    var bskyIdentifier: String = ""
    var bskyPassword: String = ""
    var bskyServiceUrl: String = "https://bsky.social"
    var groupName: String = ""
    var groupEmoji: String = ""
    var profileSyncSourceUsername: String = ""

    var twitterUsernameList: [String] {
        twitterUsernames
            .split(whereSeparator: { $0 == "," || $0 == " " || $0 == "\n" || $0 == "\t" })
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "@", with: "") }
            .filter { !$0.isEmpty }
    }
}
