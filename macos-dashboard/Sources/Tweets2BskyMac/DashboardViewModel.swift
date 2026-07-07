import AppKit
import Combine
import Foundation

@MainActor
final class DashboardViewModel: ObservableObject {
    @Published var serverConfig: ServerConfig
    @Published var authIdentifier: String = ""
    @Published var authPassword: String = ""
    @Published var registerUsername: String = ""
    @Published var registerEmail: String = ""
    @Published var registerPassword: String = ""

    @Published var token: String?
    @Published var bootstrapOpen: Bool = false
    @Published var me: AuthUser?

    @Published var mappings: [AccountMapping] = []
    @Published var groups: [AccountGroup] = []
    @Published var status: StatusResponse?
    @Published var recentActivity: [ActivityLog] = []
    @Published var enrichedPosts: [EnrichedPost] = []
    @Published var postsSearchQuery: String = ""
    @Published var localPostSearchResults: [LocalPostSearchResult] = []
    @Published var runtimeVersion: RuntimeVersionInfo?
    @Published var updateStatus: UpdateStatusInfo?

    @Published var twitterConfig: TwitterConfig = .empty
    @Published var aiConfig: AIConfig = .empty
    @Published var managedUsers: [ManagedUser] = []

    @Published var selectedMappingIDs: Set<String> = []
    @Published var newMappingDraft = MappingDraft()
    @Published var selectedMappingForEdit: AccountMapping?
    @Published var editMappingDraft = MappingDraft()
    @Published var twitterProfilePreview: TwitterMirrorProfile?
    @Published var credentialValidation: BlueskyCredentialValidation?

    @Published var newGroupName: String = ""
    @Published var newGroupEmoji: String = ""

    @Published var newUserUsername: String = ""
    @Published var newUserEmail: String = ""
    @Published var newUserPassword: String = ""
    @Published var newUserIsAdmin: Bool = false
    @Published var editingUser: ManagedUser?
    @Published var editUserUsername: String = ""
    @Published var editUserEmail: String = ""
    @Published var editUserIsAdmin: Bool = false

    @Published var currentEmailInput: String = ""
    @Published var newEmailInput: String = ""
    @Published var changeEmailPasswordInput: String = ""
    @Published var currentPasswordInput: String = ""
    @Published var newPasswordInput: String = ""
    @Published var confirmPasswordInput: String = ""

    @Published var isBusy: Bool = false
    @Published var isPolling: Bool = false
    @Published var notice: String = ""
    @Published var noticeIsError: Bool = false

    private let defaults = UserDefaults.standard
    private let serverDefaultsKey = "mac-server-config"
    private let tokenDefaultsKey = "mac-auth-token"
    private var apiClient: APIClient

    var isAuthenticated: Bool {
        token != nil
    }

    var isAdmin: Bool {
        me?.isAdmin == true
    }

    init() {
        let loadedConfig: ServerConfig
        if let data = defaults.data(forKey: serverDefaultsKey),
           let decoded = try? JSONDecoder().decode(ServerConfig.self, from: data) {
            loadedConfig = decoded
        } else {
            loadedConfig = .default
        }

        let loadedToken = defaults.string(forKey: tokenDefaultsKey)

        serverConfig = loadedConfig
        token = loadedToken
        apiClient = APIClient(serverConfig: loadedConfig, token: loadedToken)
    }

    func initialize() async {
        await refreshBootstrapStatus()
        guard token != nil else { return }
        await refreshAllData(showSuccessNotice: false)
    }

    func saveServerConfig() {
        if let encoded = try? JSONEncoder().encode(serverConfig) {
            defaults.set(encoded, forKey: serverDefaultsKey)
        }
        Task { await apiClient.updateServerConfig(serverConfig) }
    }

    func refreshBootstrapStatus() async {
        do {
            let response: BootstrapStatus = try await apiClient.request(
                "/api/auth/bootstrap-status",
                requiresAuth: false
            )
            bootstrapOpen = response.bootstrapOpen
        } catch {
            bootstrapOpen = false
        }
    }

    func testConnection() async {
        do {
            let _: BootstrapStatus = try await apiClient.request(
                "/api/auth/bootstrap-status",
                requiresAuth: false
            )
            showNotice("Connection successful.", isError: false)
        } catch {
            showNotice(readableError(error, fallback: "Connection failed."), isError: true)
        }
    }

    func login() async {
        struct LoginRequest: Encodable {
            let identifier: String
            let password: String
        }

        let identifier = authIdentifier.trimmingCharacters(in: .whitespacesAndNewlines)
        let password = authPassword
        guard !identifier.isEmpty, !password.isEmpty else {
            showNotice("Username/email and password are required.", isError: true)
            return
        }

        isBusy = true
        defer { isBusy = false }

        do {
            let response: LoginResponse = try await apiClient.request(
                "/api/login",
                method: .post,
                jsonBody: LoginRequest(identifier: identifier, password: password),
                requiresAuth: false
            )

            token = response.token
            await apiClient.updateToken(response.token)
            defaults.set(response.token, forKey: tokenDefaultsKey)
            authPassword = ""
            await refreshAllData(showSuccessNotice: false)
            showNotice("Signed in.", isError: false)
        } catch {
            showNotice(readableError(error, fallback: "Failed to sign in."), isError: true)
        }
    }

    func register() async {
        struct RegisterRequest: Encodable {
            let username: String?
            let email: String?
            let password: String
        }

        let username = registerUsername.trimmingCharacters(in: .whitespacesAndNewlines)
        let email = registerEmail.trimmingCharacters(in: .whitespacesAndNewlines)
        let password = registerPassword

        guard !password.isEmpty else {
            showNotice("Password is required.", isError: true)
            return
        }

        isBusy = true
        defer { isBusy = false }

        do {
            let _: APIMessageResponse = try await apiClient.request(
                "/api/register",
                method: .post,
                jsonBody: RegisterRequest(
                    username: username.isEmpty ? nil : username,
                    email: email.isEmpty ? nil : email,
                    password: password
                ),
                requiresAuth: false
            )

            registerPassword = ""
            showNotice("Registration successful. You can now sign in.", isError: false)
            await refreshBootstrapStatus()
        } catch {
            showNotice(readableError(error, fallback: "Failed to register."), isError: true)
        }
    }

    func logout(message: String? = nil) {
        token = nil
        Task { await apiClient.updateToken(nil) }
        defaults.removeObject(forKey: tokenDefaultsKey)

        me = nil
        mappings = []
        groups = []
        status = nil
        recentActivity = []
        enrichedPosts = []
        localPostSearchResults = []
        runtimeVersion = nil
        updateStatus = nil
        managedUsers = []
        selectedMappingIDs = []

        if let message {
            showNotice(message, isError: true)
        }
    }

    func refreshAllData(showSuccessNotice: Bool = true) async {
        guard token != nil else {
            await refreshBootstrapStatus()
            return
        }

        isPolling = true
        defer { isPolling = false }

        do {
            let meResponse: AuthUser = try await apiClient.request("/api/me")
            me = meResponse
            currentEmailInput = meResponse.email ?? ""

            mappings = try await apiClient.request("/api/mappings")
            groups = try await apiClient.request("/api/groups")
            status = try await apiClient.request("/api/status")
            recentActivity = try await apiClient.request(
                "/api/recent-activity",
                queryItems: [URLQueryItem(name: "limit", value: "30")]
            )
            enrichedPosts = try await apiClient.request(
                "/api/posts/enriched",
                queryItems: [URLQueryItem(name: "limit", value: "30")]
            )
            runtimeVersion = try await apiClient.request("/api/version")

            if isAdmin {
                twitterConfig = try await apiClient.request("/api/twitter-config")
                aiConfig = try await apiClient.request("/api/ai-config")
                updateStatus = try await apiClient.request("/api/update-status")
                managedUsers = try await apiClient.request("/api/admin/users")
            } else {
                updateStatus = nil
                managedUsers = []
            }

            if showSuccessNotice {
                showNotice("Dashboard refreshed.", isError: false)
            }
        } catch {
            handlePotentialAuthError(error)
            showNotice(readableError(error, fallback: "Failed to refresh dashboard data."), isError: true)
        }
    }

    func poll() async {
        guard isAuthenticated, !isPolling else { return }
        await refreshAllData(showSuccessNotice: false)
    }

    func runNow() async {
        guard isAuthenticated else { return }
        do {
            let _: APIMessageResponse = try await apiClient.request(
                "/api/run-now",
                method: .post,
                bodyData: Data("{}".utf8),
                requiresAuth: true
            )
            showNotice("Run requested.", isError: false)
            await refreshAllData(showSuccessNotice: false)
        } catch {
            handlePotentialAuthError(error)
            showNotice(readableError(error, fallback: "Failed to trigger run."), isError: true)
        }
    }

    func clearAllBackfills() async {
        guard isAdmin else { return }
        do {
            let _: APIMessageResponse = try await apiClient.request(
                "/api/backfill/clear-all",
                method: .post,
                bodyData: Data("{}".utf8)
            )
            showNotice("Backfill queue cleared.", isError: false)
            await refreshAllData(showSuccessNotice: false)
        } catch {
            handlePotentialAuthError(error)
            showNotice(readableError(error, fallback: "Failed to clear queue."), isError: true)
        }
    }

    func queueBackfill(mappingId: String, limit: Int = 15) async {
        struct BackfillRequest: Encodable { let limit: Int }
        do {
            let _: APIMessageResponse = try await apiClient.request(
                "/api/backfill/\(mappingId)",
                method: .post,
                jsonBody: BackfillRequest(limit: limit)
            )
            showNotice("Backfill queued.", isError: false)
            await refreshAllData(showSuccessNotice: false)
        } catch {
            handlePotentialAuthError(error)
            showNotice(readableError(error, fallback: "Failed to queue backfill."), isError: true)
        }
    }

    func cancelBackfill(mappingId: String) async {
        do {
            let _: APIMessageResponse = try await apiClient.request(
                "/api/backfill/\(mappingId)",
                method: .delete
            )
            showNotice("Backfill cancelled.", isError: false)
            await refreshAllData(showSuccessNotice: false)
        } catch {
            handlePotentialAuthError(error)
            showNotice(readableError(error, fallback: "Failed to cancel backfill."), isError: true)
        }
    }

    func clearMappingCache(mappingId: String) async {
        guard isAdmin else { return }
        do {
            let _: APIMessageResponse = try await apiClient.request(
                "/api/mappings/\(mappingId)/cache",
                method: .delete
            )
            showNotice("Mapping cache cleared.", isError: false)
        } catch {
            handlePotentialAuthError(error)
            showNotice(readableError(error, fallback: "Failed to clear mapping cache."), isError: true)
        }
    }

    func deleteAllPosts(mappingId: String) async {
        guard isAdmin else { return }
        do {
            let response: APIMessageResponse = try await apiClient.request(
                "/api/mappings/\(mappingId)/delete-all-posts",
                method: .post,
                bodyData: Data("{}".utf8)
            )
            showNotice(response.message ?? "Delete posts request completed.", isError: false)
            await refreshAllData(showSuccessNotice: false)
        } catch {
            handlePotentialAuthError(error)
            showNotice(readableError(error, fallback: "Failed to delete all posts."), isError: true)
        }
    }

    func createGroup() async {
        struct GroupRequest: Encodable {
            let name: String
            let emoji: String
        }

        let name = newGroupName.trimmingCharacters(in: .whitespacesAndNewlines)
        let emoji = newGroupEmoji.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else {
            showNotice("Group name is required.", isError: true)
            return
        }

        do {
            let _: AccountGroup = try await apiClient.request(
                "/api/groups",
                method: .post,
                jsonBody: GroupRequest(name: name, emoji: emoji)
            )
            newGroupName = ""
            newGroupEmoji = ""
            showNotice("Group created.", isError: false)
            await refreshAllData(showSuccessNotice: false)
        } catch {
            handlePotentialAuthError(error)
            showNotice(readableError(error, fallback: "Failed to create group."), isError: true)
        }
    }

    func renameGroup(currentKey: String, name: String, emoji: String) async {
        struct GroupRequest: Encodable {
            let name: String
            let emoji: String
        }

        do {
            let _: AccountGroup = try await apiClient.request(
                "/api/groups/\(currentKey.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? currentKey)",
                method: .put,
                jsonBody: GroupRequest(name: name, emoji: emoji)
            )
            showNotice("Group renamed.", isError: false)
            await refreshAllData(showSuccessNotice: false)
        } catch {
            handlePotentialAuthError(error)
            showNotice(readableError(error, fallback: "Failed to rename group."), isError: true)
        }
    }

    func deleteGroup(groupKey: String) async {
        do {
            let _: APIMessageResponse = try await apiClient.request(
                "/api/groups/\(groupKey.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? groupKey)",
                method: .delete
            )
            showNotice("Group deleted.", isError: false)
            await refreshAllData(showSuccessNotice: false)
        } catch {
            handlePotentialAuthError(error)
            showNotice(readableError(error, fallback: "Failed to delete group."), isError: true)
        }
    }

    func previewTwitterProfile() async {
        struct PreviewRequest: Encodable { let twitterUsername: String }

        let source = normalizedSourceUsername(from: newMappingDraft)
        guard !source.isEmpty else {
            showNotice("Add at least one Twitter source username.", isError: true)
            return
        }

        do {
            let preview: TwitterMirrorProfile = try await apiClient.request(
                "/api/onboarding/twitter-profile",
                method: .post,
                jsonBody: PreviewRequest(twitterUsername: source)
            )
            twitterProfilePreview = preview
            showNotice("Loaded Twitter profile preview for @\(source).", isError: false)
        } catch {
            handlePotentialAuthError(error)
            showNotice(readableError(error, fallback: "Failed to load Twitter profile."), isError: true)
        }
    }

    func validateBlueskyCredentials() async {
        struct ValidateRequest: Encodable {
            let bskyIdentifier: String
            let bskyPassword: String
            let bskyServiceUrl: String
        }

        let identifier = newMappingDraft.bskyIdentifier.trimmingCharacters(in: .whitespacesAndNewlines)
        let password = newMappingDraft.bskyPassword.trimmingCharacters(in: .whitespacesAndNewlines)
        let service = newMappingDraft.bskyServiceUrl.trimmingCharacters(in: .whitespacesAndNewlines)

        guard !identifier.isEmpty, !password.isEmpty else {
            showNotice("Bluesky identifier and app password are required.", isError: true)
            return
        }

        do {
            let validation: BlueskyCredentialValidation = try await apiClient.request(
                "/api/onboarding/bsky-credentials",
                method: .post,
                jsonBody: ValidateRequest(
                    bskyIdentifier: identifier,
                    bskyPassword: password,
                    bskyServiceUrl: service.isEmpty ? "https://bsky.social" : service
                )
            )
            credentialValidation = validation
            showNotice("Bluesky credentials validated.", isError: false)
        } catch {
            handlePotentialAuthError(error)
            showNotice(readableError(error, fallback: "Failed to validate credentials."), isError: true)
        }
    }

    func createMapping() async {
        struct CreateMappingRequest: Encodable {
            let owner: String?
            let twitterUsernames: [String]
            let bskyIdentifier: String
            let bskyPassword: String
            let bskyServiceUrl: String
            let groupName: String?
            let groupEmoji: String?
            let profileSyncSourceUsername: String?
        }

        let usernames = newMappingDraft.twitterUsernameList
        let identifier = newMappingDraft.bskyIdentifier.trimmingCharacters(in: .whitespacesAndNewlines)
        let password = newMappingDraft.bskyPassword
        let service = newMappingDraft.bskyServiceUrl.trimmingCharacters(in: .whitespacesAndNewlines)

        guard !usernames.isEmpty, !identifier.isEmpty, !password.isEmpty else {
            showNotice("Twitter usernames, Bluesky identifier, and app password are required.", isError: true)
            return
        }

        do {
            let created: AccountMapping = try await apiClient.request(
                "/api/mappings",
                method: .post,
                jsonBody: CreateMappingRequest(
                    owner: newMappingDraft.owner.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
                    twitterUsernames: usernames,
                    bskyIdentifier: identifier,
                    bskyPassword: password,
                    bskyServiceUrl: service.isEmpty ? "https://bsky.social" : service,
                    groupName: newMappingDraft.groupName.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
                    groupEmoji: newMappingDraft.groupEmoji.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
                    profileSyncSourceUsername: normalizedSourceUsername(from: newMappingDraft).nilIfEmpty
                )
            )

            let source = normalizedSourceUsername(from: newMappingDraft)
            if !source.isEmpty {
                struct SyncRequest: Encodable { let sourceTwitterUsername: String }
                let _: MirrorProfileSyncResult = try await apiClient.request(
                    "/api/mappings/\(created.id)/sync-profile-from-twitter",
                    method: .post,
                    jsonBody: SyncRequest(sourceTwitterUsername: source)
                )
            }

            newMappingDraft = MappingDraft()
            twitterProfilePreview = nil
            credentialValidation = nil
            showNotice("Mapping created.", isError: false)
            await refreshAllData(showSuccessNotice: false)
        } catch {
            handlePotentialAuthError(error)
            showNotice(readableError(error, fallback: "Failed to create mapping."), isError: true)
        }
    }

    func beginEditing(mapping: AccountMapping) {
        selectedMappingForEdit = mapping
        editMappingDraft = MappingDraft(
            owner: mapping.owner ?? "",
            twitterUsernames: mapping.twitterUsernames.joined(separator: ", "),
            bskyIdentifier: mapping.bskyIdentifier,
            bskyPassword: "",
            bskyServiceUrl: mapping.bskyServiceUrl ?? "https://bsky.social",
            groupName: mapping.groupName ?? "",
            groupEmoji: mapping.groupEmoji ?? "",
            profileSyncSourceUsername: mapping.profileSyncSourceUsername ?? mapping.twitterUsernames.first ?? ""
        )
    }

    func cancelEditingMapping() {
        selectedMappingForEdit = nil
        editMappingDraft = MappingDraft()
    }

    func saveEditedMapping() async {
        struct UpdateMappingRequest: Encodable {
            let owner: String?
            let twitterUsernames: [String]
            let bskyIdentifier: String
            let bskyPassword: String
            let bskyServiceUrl: String
            let groupName: String?
            let groupEmoji: String?
            let profileSyncSourceUsername: String?
        }

        guard let mapping = selectedMappingForEdit else { return }
        let usernames = editMappingDraft.twitterUsernameList
        let identifier = editMappingDraft.bskyIdentifier.trimmingCharacters(in: .whitespacesAndNewlines)

        guard !usernames.isEmpty, !identifier.isEmpty else {
            showNotice("At least one Twitter username and Bluesky identifier are required.", isError: true)
            return
        }

        do {
            let _: AccountMapping = try await apiClient.request(
                "/api/mappings/\(mapping.id)",
                method: .put,
                jsonBody: UpdateMappingRequest(
                    owner: editMappingDraft.owner.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
                    twitterUsernames: usernames,
                    bskyIdentifier: identifier,
                    bskyPassword: editMappingDraft.bskyPassword,
                    bskyServiceUrl: editMappingDraft.bskyServiceUrl.trimmingCharacters(in: .whitespacesAndNewlines),
                    groupName: editMappingDraft.groupName.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
                    groupEmoji: editMappingDraft.groupEmoji.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
                    profileSyncSourceUsername: normalizedSourceUsername(from: editMappingDraft).nilIfEmpty
                )
            )
            cancelEditingMapping()
            showNotice("Mapping updated.", isError: false)
            await refreshAllData(showSuccessNotice: false)
        } catch {
            handlePotentialAuthError(error)
            showNotice(readableError(error, fallback: "Failed to update mapping."), isError: true)
        }
    }

    func deleteMapping(mappingId: String) async {
        do {
            let _: APIMessageResponse = try await apiClient.request(
                "/api/mappings/\(mappingId)",
                method: .delete
            )
            selectedMappingIDs.remove(mappingId)
            showNotice("Mapping deleted.", isError: false)
            await refreshAllData(showSuccessNotice: false)
        } catch {
            handlePotentialAuthError(error)
            showNotice(readableError(error, fallback: "Failed to delete mapping."), isError: true)
        }
    }

    func syncProfile(mappingId: String, source: String) async {
        struct SyncRequest: Encodable { let sourceTwitterUsername: String }

        do {
            let _: MirrorProfileSyncResult = try await apiClient.request(
                "/api/mappings/\(mappingId)/sync-profile-from-twitter",
                method: .post,
                jsonBody: SyncRequest(sourceTwitterUsername: source)
            )
            showNotice("Profile sync complete.", isError: false)
            await refreshAllData(showSuccessNotice: false)
        } catch {
            handlePotentialAuthError(error)
            showNotice(readableError(error, fallback: "Failed to sync profile."), isError: true)
        }
    }

    func pullTwitterBio(mappingId: String, source: String) async {
        struct SyncRequest: Encodable { let sourceTwitterUsername: String }

        do {
            let _: MirrorProfileSyncResult = try await apiClient.request(
                "/api/mappings/\(mappingId)/pull-twitter-bio",
                method: .post,
                jsonBody: SyncRequest(sourceTwitterUsername: source)
            )
            showNotice("Twitter bio pull complete.", isError: false)
            await refreshAllData(showSuccessNotice: false)
        } catch {
            handlePotentialAuthError(error)
            showNotice(readableError(error, fallback: "Failed to pull Twitter bio."), isError: true)
        }
    }

    func bridgeToFediverse(mappingId: String) async {
        do {
            let _: APIMessageResponse = try await apiClient.request(
                "/api/mappings/\(mappingId)/bridge-to-fediverse",
                method: .post,
                bodyData: Data("{}".utf8)
            )
            showNotice("Fediverse bridge enabled.", isError: false)
            await refreshAllData(showSuccessNotice: false)
        } catch {
            handlePotentialAuthError(error)
            showNotice(readableError(error, fallback: "Failed to bridge account."), isError: true)
        }
    }

    func applyBotLabelAll(selectedOnly: Bool) async {
        struct RequestBody: Encodable { let mappingIds: [String] }
        let mappingIds = selectedOnly ? Array(selectedMappingIDs) : mappings.map(\.id)

        do {
            let result: BulkBotLabelAllResult = try await apiClient.request(
                "/api/mappings/bot-label-all",
                method: .post,
                jsonBody: RequestBody(mappingIds: mappingIds)
            )
            showNotice(
                "Bot labels: \(result.labeled) added, \(result.alreadyLabeled) already labeled, \(result.failed) failed.",
                isError: result.failed > 0
            )
            await refreshAllData(showSuccessNotice: false)
        } catch {
            handlePotentialAuthError(error)
            showNotice(readableError(error, fallback: "Failed bot-label bulk action."), isError: true)
        }
    }

    func appendBotNameAll(selectedOnly: Bool) async {
        struct RequestBody: Encodable { let mappingIds: [String] }
        let mappingIds = selectedOnly ? Array(selectedMappingIDs) : mappings.map(\.id)

        do {
            let result: BulkAppendBotNameAllResult = try await apiClient.request(
                "/api/mappings/append-bot-name-all",
                method: .post,
                jsonBody: RequestBody(mappingIds: mappingIds)
            )
            showNotice(
                "Name suffix: \(result.appended) updated, \(result.alreadyAppended) already set, \(result.failed) failed.",
                isError: result.failed > 0
            )
            await refreshAllData(showSuccessNotice: false)
        } catch {
            handlePotentialAuthError(error)
            showNotice(readableError(error, fallback: "Failed append-name bulk action."), isError: true)
        }
    }

    func syncAllProfiles(selectedOnly: Bool) async {
        let targets = selectedOnly ? mappings.filter { selectedMappingIDs.contains($0.id) } : mappings
        for mapping in targets {
            let source = mapping.profileSyncSourceUsername ?? mapping.twitterUsernames.first ?? ""
            if source.isEmpty { continue }
            await syncProfile(mappingId: mapping.id, source: source)
        }
    }

    func pullAllBios(selectedOnly: Bool) async {
        let targets = selectedOnly ? mappings.filter { selectedMappingIDs.contains($0.id) } : mappings
        for mapping in targets {
            let source = mapping.profileSyncSourceUsername ?? mapping.twitterUsernames.first ?? ""
            if source.isEmpty { continue }
            await pullTwitterBio(mappingId: mapping.id, source: source)
        }
    }

    func bridgeAll(selectedOnly: Bool) async {
        let targets = selectedOnly ? mappings.filter { selectedMappingIDs.contains($0.id) } : mappings
        for mapping in targets {
            await bridgeToFediverse(mappingId: mapping.id)
        }
    }

    func searchPosts() async {
        let trimmed = postsSearchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            localPostSearchResults = []
            return
        }

        do {
            let results: [LocalPostSearchResult] = try await apiClient.request(
                "/api/posts/search",
                queryItems: [
                    URLQueryItem(name: "q", value: trimmed),
                    URLQueryItem(name: "limit", value: "120")
                ]
            )
            localPostSearchResults = results
        } catch {
            handlePotentialAuthError(error)
            showNotice(readableError(error, fallback: "Post search failed."), isError: true)
        }
    }

    func saveTwitterConfig() async {
        struct SaveTwitterRequest: Encodable {
            let authToken: String
            let ct0: String
            let backupAuthToken: String?
            let backupCt0: String?
        }

        do {
            let _: APIMessageResponse = try await apiClient.request(
                "/api/twitter-config",
                method: .post,
                jsonBody: SaveTwitterRequest(
                    authToken: twitterConfig.authToken,
                    ct0: twitterConfig.ct0,
                    backupAuthToken: twitterConfig.backupAuthToken,
                    backupCt0: twitterConfig.backupCt0
                )
            )
            showNotice("Twitter settings saved.", isError: false)
        } catch {
            handlePotentialAuthError(error)
            showNotice(readableError(error, fallback: "Failed to save Twitter config."), isError: true)
        }
    }

    func saveAIConfig() async {
        struct SaveAIRequest: Encodable {
            let provider: String
            let apiKey: String?
            let model: String?
            let baseUrl: String?
        }

        do {
            let _: APIMessageResponse = try await apiClient.request(
                "/api/ai-config",
                method: .post,
                jsonBody: SaveAIRequest(
                    provider: aiConfig.provider,
                    apiKey: aiConfig.apiKey,
                    model: aiConfig.model,
                    baseUrl: aiConfig.baseUrl
                )
            )
            showNotice("AI settings saved.", isError: false)
        } catch {
            handlePotentialAuthError(error)
            showNotice(readableError(error, fallback: "Failed to save AI config."), isError: true)
        }
    }

    func runUpdate() async {
        do {
            let response: APIMessageResponse = try await apiClient.request(
                "/api/update",
                method: .post,
                bodyData: Data("{}".utf8)
            )
            showNotice(response.message ?? "Update started.", isError: false)
            await refreshAllData(showSuccessNotice: false)
        } catch {
            handlePotentialAuthError(error)
            showNotice(readableError(error, fallback: "Failed to start update."), isError: true)
        }
    }

    func exportConfig() async {
        do {
            let data = try await apiClient.requestData("/api/config/export")
            let panel = NSSavePanel()
            panel.canCreateDirectories = true
            panel.nameFieldStringValue = "tweets-2-bsky-config-\(Self.dateStamp()).json"
            panel.allowedContentTypes = [.json]
            if panel.runModal() == .OK, let url = panel.url {
                try data.write(to: url)
                showNotice("Configuration exported to \(url.path).", isError: false)
            }
        } catch {
            handlePotentialAuthError(error)
            showNotice(readableError(error, fallback: "Failed to export config."), isError: true)
        }
    }

    func importConfig() async {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [.json]

        guard panel.runModal() == .OK, let url = panel.url else {
            return
        }

        do {
            let data = try Data(contentsOf: url)
            let _: APIMessageResponse = try await apiClient.request(
                "/api/config/import",
                method: .post,
                bodyData: data
            )
            showNotice("Configuration imported.", isError: false)
            await refreshAllData(showSuccessNotice: false)
        } catch {
            handlePotentialAuthError(error)
            showNotice(readableError(error, fallback: "Failed to import config."), isError: true)
        }
    }

    func createUser() async {
        struct CreateUserRequest: Encodable {
            let username: String?
            let email: String?
            let password: String
            let isAdmin: Bool
            let permissions: UserPermissions
        }

        let username = newUserUsername.trimmingCharacters(in: .whitespacesAndNewlines)
        let email = newUserEmail.trimmingCharacters(in: .whitespacesAndNewlines)
        let password = newUserPassword
        guard !password.isEmpty else {
            showNotice("New user password is required.", isError: true)
            return
        }

        do {
            let _: ManagedUser? = try await apiClient.request(
                "/api/admin/users",
                method: .post,
                jsonBody: CreateUserRequest(
                    username: username.nilIfEmpty,
                    email: email.nilIfEmpty,
                    password: password,
                    isAdmin: newUserIsAdmin,
                    permissions: newUserIsAdmin ? .adminPermissions : .default
                )
            )
            newUserUsername = ""
            newUserEmail = ""
            newUserPassword = ""
            newUserIsAdmin = false
            showNotice("User created.", isError: false)
            await refreshAllData(showSuccessNotice: false)
        } catch {
            handlePotentialAuthError(error)
            showNotice(readableError(error, fallback: "Failed to create user."), isError: true)
        }
    }

    func beginEditingUser(_ user: ManagedUser) {
        editingUser = user
        editUserUsername = user.username ?? ""
        editUserEmail = user.email ?? ""
        editUserIsAdmin = user.isAdmin
    }

    func cancelEditingUser() {
        editingUser = nil
        editUserUsername = ""
        editUserEmail = ""
        editUserIsAdmin = false
    }

    func saveEditedUser() async {
        struct UpdateUserRequest: Encodable {
            let username: String?
            let email: String?
            let isAdmin: Bool
            let permissions: UserPermissions
        }

        guard let user = editingUser else { return }

        do {
            let _: ManagedUser? = try await apiClient.request(
                "/api/admin/users/\(user.id)",
                method: .put,
                jsonBody: UpdateUserRequest(
                    username: editUserUsername.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
                    email: editUserEmail.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
                    isAdmin: editUserIsAdmin,
                    permissions: editUserIsAdmin ? .adminPermissions : .default
                )
            )
            cancelEditingUser()
            showNotice("User updated.", isError: false)
            await refreshAllData(showSuccessNotice: false)
        } catch {
            handlePotentialAuthError(error)
            showNotice(readableError(error, fallback: "Failed to update user."), isError: true)
        }
    }

    func resetUserPassword(userId: String, newPassword: String) async {
        struct ResetPasswordRequest: Encodable {
            let newPassword: String
        }

        do {
            let _: APIMessageResponse = try await apiClient.request(
                "/api/admin/users/\(userId)/reset-password",
                method: .post,
                jsonBody: ResetPasswordRequest(newPassword: newPassword)
            )
            showNotice("User password reset.", isError: false)
        } catch {
            handlePotentialAuthError(error)
            showNotice(readableError(error, fallback: "Failed to reset password."), isError: true)
        }
    }

    func deleteUser(userId: String) async {
        do {
            let _: APIMessageResponse = try await apiClient.request(
                "/api/admin/users/\(userId)",
                method: .delete
            )
            showNotice("User deleted.", isError: false)
            await refreshAllData(showSuccessNotice: false)
        } catch {
            handlePotentialAuthError(error)
            showNotice(readableError(error, fallback: "Failed to delete user."), isError: true)
        }
    }

    func changeOwnEmail() async {
        struct ChangeEmailRequest: Encodable {
            let currentEmail: String
            let newEmail: String
            let password: String
        }

        do {
            let response: APIMessageResponse = try await apiClient.request(
                "/api/me/change-email",
                method: .post,
                jsonBody: ChangeEmailRequest(
                    currentEmail: currentEmailInput,
                    newEmail: newEmailInput,
                    password: changeEmailPasswordInput
                )
            )

            if let token = response.token {
                self.token = token
                await apiClient.updateToken(token)
                defaults.set(token, forKey: tokenDefaultsKey)
            }

            currentEmailInput = newEmailInput
            newEmailInput = ""
            changeEmailPasswordInput = ""
            showNotice("Email updated.", isError: false)
            await refreshAllData(showSuccessNotice: false)
        } catch {
            handlePotentialAuthError(error)
            showNotice(readableError(error, fallback: "Failed to update email."), isError: true)
        }
    }

    func changeOwnPassword() async {
        struct ChangePasswordRequest: Encodable {
            let currentPassword: String
            let newPassword: String
        }

        guard newPasswordInput == confirmPasswordInput else {
            showNotice("New password and confirmation do not match.", isError: true)
            return
        }

        do {
            let _: APIMessageResponse = try await apiClient.request(
                "/api/me/change-password",
                method: .post,
                jsonBody: ChangePasswordRequest(
                    currentPassword: currentPasswordInput,
                    newPassword: newPasswordInput
                )
            )
            currentPasswordInput = ""
            newPasswordInput = ""
            confirmPasswordInput = ""
            showNotice("Password updated.", isError: false)
        } catch {
            handlePotentialAuthError(error)
            showNotice(readableError(error, fallback: "Failed to update password."), isError: true)
        }
    }

    private func normalizedSourceUsername(from draft: MappingDraft) -> String {
        let explicit = draft.profileSyncSourceUsername
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "@", with: "")
        if !explicit.isEmpty {
            return explicit
        }
        return draft.twitterUsernameList.first ?? ""
    }

    private func handlePotentialAuthError(_ error: Error) {
        if case APIClientError.unauthorized = error {
            logout(message: "Session expired. Please sign in again.")
        }
    }

    private func readableError(_ error: Error, fallback: String) -> String {
        if let apiError = error as? APIClientError {
            return apiError.localizedDescription
        }
        let description = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        return description.isEmpty ? fallback : description
    }

    private func showNotice(_ message: String, isError: Bool) {
        notice = message
        noticeIsError = isError
    }

    private static func dateStamp() -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: Date())
    }
}

private extension String {
    var nilIfEmpty: String? {
        isEmpty ? nil : self
    }
}

private extension UserPermissions {
    static let adminPermissions = UserPermissions(
        viewAllMappings: true,
        manageOwnMappings: true,
        manageAllMappings: true,
        manageGroups: true,
        queueBackfills: true,
        runNow: true
    )
}
