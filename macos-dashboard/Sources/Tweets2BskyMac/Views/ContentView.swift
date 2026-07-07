import SwiftUI

private enum DashboardTab: Hashable {
    case overview
    case accounts
    case posts
    case activity
    case settings
}

private enum BulkAccountsAction: String, CaseIterable, Identifiable {
    case syncProfiles = "sync_profiles"
    case pullBio = "pull_twitter_bio"
    case bridgeAll = "bridge_all"
    case applyBotLabel = "apply_bot_label"
    case appendBotName = "append_bot_name"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .syncProfiles:
            return "Sync profiles"
        case .pullBio:
            return "Pull Twitter bios"
        case .bridgeAll:
            return "Bridge to fediverse"
        case .applyBotLabel:
            return "Apply bot label"
        case .appendBotName:
            return "Append {bot}"
        }
    }
}

struct ContentView: View {
    @EnvironmentObject private var vm: DashboardViewModel

    @State private var selectedTab: DashboardTab = .overview
    @State private var showingRegister = false
    @State private var accountsSearch = ""
    @State private var onlySelectedForBulk = false
    @State private var bulkAction: BulkAccountsAction = .syncProfiles
    @State private var postsSelection = ""
    @State private var renameGroupName: String = ""
    @State private var renameGroupEmoji: String = ""
    @State private var groupToRenameKey: String?
    @State private var showingEditMappingSheet = false
    @State private var resetPasswordDrafts: [String: String] = [:]
    @State private var pollTask: Task<Void, Never>?

    var body: some View {
        Group {
            if vm.isAuthenticated {
                dashboardShell
            } else {
                authView
            }
        }
        .alert("Notice", isPresented: Binding(
            get: { !vm.notice.isEmpty },
            set: { newValue in
                if !newValue {
                    vm.notice = ""
                }
            }
        )) {
            Button("OK", role: .cancel) {
                vm.notice = ""
            }
        } message: {
            Text(vm.notice)
                .foregroundStyle(vm.noticeIsError ? .red : .primary)
        }
        .task(id: vm.isAuthenticated) {
            pollTask?.cancel()
            guard vm.isAuthenticated else { return }
            pollTask = Task {
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(15))
                    if Task.isCancelled { return }
                    await vm.poll()
                }
            }
        }
        .onDisappear {
            pollTask?.cancel()
        }
    }

    private var authView: some View {
        VStack(spacing: 20) {
            Text("Tweets-2-Bsky macOS")
                .font(.largeTitle.bold())

            VStack(alignment: .leading, spacing: 12) {
                Text("Server Connection")
                    .font(.headline)
                HStack {
                    TextField("Host or Tailscale IP", text: $vm.serverConfig.host)
                        .textFieldStyle(.roundedBorder)
                    TextField("Port", text: $vm.serverConfig.port)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 90)
                    Toggle("HTTPS", isOn: $vm.serverConfig.useHTTPS)
                        .toggleStyle(.switch)
                }
                Text("Base URL: \(vm.serverConfig.baseURLString)")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                HStack {
                    Button("Save Server") {
                        vm.saveServerConfig()
                    }
                    Button("Test Connection") {
                        Task {
                            vm.saveServerConfig()
                            await vm.testConnection()
                        }
                    }
                }
            }
            .padding()
            .background(RoundedRectangle(cornerRadius: 10).fill(.quaternary.opacity(0.25)))

            VStack(alignment: .leading, spacing: 12) {
                Picker("Auth", selection: $showingRegister) {
                    Text("Sign In").tag(false)
                    Text("Register").tag(true)
                }
                .pickerStyle(.segmented)

                if showingRegister {
                    TextField("Username (optional)", text: $vm.registerUsername)
                        .textFieldStyle(.roundedBorder)
                    TextField("Email (optional)", text: $vm.registerEmail)
                        .textFieldStyle(.roundedBorder)
                    SecureField("Password", text: $vm.registerPassword)
                        .textFieldStyle(.roundedBorder)

                    Button("Create Account") {
                        Task {
                            vm.saveServerConfig()
                            await vm.register()
                        }
                    }
                    .disabled(vm.isBusy || (!vm.bootstrapOpen && vm.registerUsername.isEmpty && vm.registerEmail.isEmpty))

                    if !vm.bootstrapOpen {
                        Text("Registration is disabled after first user is created.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                } else {
                    TextField("Username or email", text: $vm.authIdentifier)
                        .textFieldStyle(.roundedBorder)
                    SecureField("Password", text: $vm.authPassword)
                        .textFieldStyle(.roundedBorder)

                    Button("Sign In") {
                        Task {
                            vm.saveServerConfig()
                            await vm.login()
                        }
                    }
                    .disabled(vm.isBusy)
                }
            }
            .padding()
            .background(RoundedRectangle(cornerRadius: 10).fill(.quaternary.opacity(0.25)))
        }
        .padding(28)
        .frame(maxWidth: 680)
    }

    private var dashboardShell: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Tweets-2-Bsky")
                        .font(.title2.bold())
                    Text("\(vm.serverConfig.baseURLString)  |  \(vm.me?.username ?? vm.me?.email ?? "user")")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if let version = vm.runtimeVersion {
                    Text("v\(version.version) \(version.commit ?? "")")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Button {
                    Task { await vm.refreshAllData() }
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                .disabled(vm.isPolling)

                Button {
                    Task { await vm.runNow() }
                } label: {
                    Label("Run Now", systemImage: "play.fill")
                }

                if vm.isAdmin {
                    Button(role: .destructive) {
                        Task { await vm.clearAllBackfills() }
                    } label: {
                        Label("Clear Queue", systemImage: "trash")
                    }
                }

                Button(role: .destructive) {
                    vm.logout()
                } label: {
                    Label("Logout", systemImage: "rectangle.portrait.and.arrow.right")
                }
            }
            .padding()
            .background(.quaternary.opacity(0.15))

            TabView(selection: $selectedTab) {
                overviewTab
                    .tabItem { Label("Overview", systemImage: "gauge.with.needle") }
                    .tag(DashboardTab.overview)

                accountsTab
                    .tabItem { Label("Accounts", systemImage: "person.3") }
                    .tag(DashboardTab.accounts)

                postsTab
                    .tabItem { Label("Posts", systemImage: "text.bubble") }
                    .tag(DashboardTab.posts)

                activityTab
                    .tabItem { Label("Activity", systemImage: "clock.arrow.trianglehead.counterclockwise.rotate.90") }
                    .tag(DashboardTab.activity)

                settingsTab
                    .tabItem { Label("Settings", systemImage: "gearshape") }
                    .tag(DashboardTab.settings)
            }
        }
        .sheet(isPresented: $showingEditMappingSheet) {
            editMappingSheet
        }
        .sheet(isPresented: Binding(
            get: { groupToRenameKey != nil },
            set: { newValue, _ in
                if !newValue {
                    groupToRenameKey = nil
                }
            }
        )) {
            if let key = groupToRenameKey {
                renameGroupSheet(key: key)
            }
        }
    }

    private var overviewTab: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let status = vm.status {
                    GroupBox("Current Status") {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("State: \(status.currentStatus.state)")
                            Text("Message: \(status.currentStatus.message ?? "Idle")")
                            Text("Pending Backfills: \(status.pendingBackfills.count)")
                            Text("Next check in ~\(status.nextCheckMinutes) minute(s)")
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }

                HStack(spacing: 12) {
                    statCard("Mappings", value: "\(vm.mappings.count)")
                    statCard("Groups", value: "\(vm.groups.count)")
                    statCard("Activity", value: "\(vm.recentActivity.count)")
                    statCard("Posts", value: "\(vm.enrichedPosts.count)")
                    statCard("Bot Labeled", value: "\(vm.mappings.filter { $0.hasBotLabel == true }.count)")
                }

                if let status = vm.status, !status.pendingBackfills.isEmpty {
                    GroupBox("Backfill Queue") {
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(status.pendingBackfills) { item in
                                HStack {
                                    Text("#\(item.position)")
                                        .font(.caption.monospacedDigit())
                                    Text(mappingName(id: item.id))
                                    Spacer()
                                    if let limit = item.limit {
                                        Text("limit \(limit)")
                                            .foregroundStyle(.secondary)
                                    }
                                    Button("Cancel") {
                                        Task { await vm.cancelBackfill(mappingId: item.id) }
                                    }
                                }
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }

                if let updateStatus = vm.updateStatus, vm.isAdmin {
                    GroupBox("Update Status") {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(updateStatus.running ? "Update running" : "Not running")
                            if let startedBy = updateStatus.startedBy {
                                Text("Started by: \(startedBy)")
                            }
                            if let lines = updateStatus.logTail, !lines.isEmpty {
                                Divider()
                                ForEach(lines.suffix(10), id: \.self) { line in
                                    Text(line)
                                        .font(.caption.monospaced())
                                        .textSelection(.enabled)
                                }
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            .padding()
        }
    }

    private var accountsTab: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                GroupBox("Bulk Actions") {
                    HStack {
                        Picker("Action", selection: $bulkAction) {
                            ForEach(BulkAccountsAction.allCases) { action in
                                Text(action.label).tag(action)
                            }
                        }
                        .frame(maxWidth: 260)

                        Toggle("Selected only", isOn: $onlySelectedForBulk)
                        Spacer()
                        Button("Apply") {
                            Task {
                                switch bulkAction {
                                case .syncProfiles:
                                    await vm.syncAllProfiles(selectedOnly: onlySelectedForBulk)
                                case .pullBio:
                                    await vm.pullAllBios(selectedOnly: onlySelectedForBulk)
                                case .bridgeAll:
                                    await vm.bridgeAll(selectedOnly: onlySelectedForBulk)
                                case .applyBotLabel:
                                    await vm.applyBotLabelAll(selectedOnly: onlySelectedForBulk)
                                case .appendBotName:
                                    await vm.appendBotNameAll(selectedOnly: onlySelectedForBulk)
                                }
                            }
                        }
                    }
                }

                GroupBox("Account Mappings") {
                    VStack(alignment: .leading, spacing: 10) {
                        TextField("Search by owner, Twitter source, Bluesky identifier", text: $accountsSearch)
                            .textFieldStyle(.roundedBorder)

                        if filteredMappings.isEmpty {
                            Text("No mappings match your search.")
                                .foregroundStyle(.secondary)
                        } else {
                            ForEach(filteredMappings) { mapping in
                                mappingRow(mapping)
                                Divider()
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }

                GroupBox("Add Mapping") {
                    VStack(alignment: .leading, spacing: 10) {
                        TextField("Owner", text: $vm.newMappingDraft.owner)
                            .textFieldStyle(.roundedBorder)
                        TextField("Twitter usernames (comma/space separated)", text: $vm.newMappingDraft.twitterUsernames)
                            .textFieldStyle(.roundedBorder)
                        TextField("Bluesky identifier", text: $vm.newMappingDraft.bskyIdentifier)
                            .textFieldStyle(.roundedBorder)
                        SecureField("Bluesky app password", text: $vm.newMappingDraft.bskyPassword)
                            .textFieldStyle(.roundedBorder)
                        HStack {
                            TextField("Bluesky service URL", text: $vm.newMappingDraft.bskyServiceUrl)
                                .textFieldStyle(.roundedBorder)
                            TextField("Group name", text: $vm.newMappingDraft.groupName)
                                .textFieldStyle(.roundedBorder)
                            TextField("Group emoji", text: $vm.newMappingDraft.groupEmoji)
                                .textFieldStyle(.roundedBorder)
                                .frame(width: 80)
                        }
                        TextField("Profile sync source username", text: $vm.newMappingDraft.profileSyncSourceUsername)
                            .textFieldStyle(.roundedBorder)

                        HStack {
                            Button("Preview Twitter Profile") {
                                Task { await vm.previewTwitterProfile() }
                            }
                            Button("Validate Bluesky Credentials") {
                                Task { await vm.validateBlueskyCredentials() }
                            }
                            Button("Create Mapping") {
                                Task { await vm.createMapping() }
                            }
                            .buttonStyle(.borderedProminent)
                        }

                        if let preview = vm.twitterProfilePreview {
                            Text("Twitter preview: @\(preview.username) - \(preview.name ?? preview.mirroredDisplayName)")
                                .foregroundStyle(.secondary)
                        }
                        if let validation = vm.credentialValidation {
                            Text("Credentials validated: \(validation.handle) (\(validation.did))")
                                .foregroundStyle(.secondary)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }

                GroupBox("Groups") {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            TextField("Group name", text: $vm.newGroupName)
                                .textFieldStyle(.roundedBorder)
                            TextField("Emoji", text: $vm.newGroupEmoji)
                                .textFieldStyle(.roundedBorder)
                                .frame(width: 90)
                            Button("Create") {
                                Task { await vm.createGroup() }
                            }
                        }

                        ForEach(vm.groups, id: \.self) { group in
                            HStack {
                                Text("\(group.emoji ?? "") \(group.name)")
                                Spacer()
                                Button("Rename") {
                                    renameGroupName = group.name
                                    renameGroupEmoji = group.emoji ?? ""
                                    groupToRenameKey = normalizedGroupKey(group.name)
                                }
                                Button("Delete", role: .destructive) {
                                    Task {
                                        await vm.deleteGroup(groupKey: normalizedGroupKey(group.name))
                                    }
                                }
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding()
        }
    }

    private var postsTab: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                GroupBox("Search Local Posts") {
                    HStack {
                        TextField("Search tweets/posts", text: $vm.postsSearchQuery)
                            .textFieldStyle(.roundedBorder)
                            .onSubmit {
                                Task { await vm.searchPosts() }
                            }
                        Button("Search") {
                            Task { await vm.searchPosts() }
                        }
                    }

                    if vm.localPostSearchResults.isEmpty {
                        Text("No local search results.")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(vm.localPostSearchResults.prefix(120)) { row in
                            VStack(alignment: .leading, spacing: 4) {
                                Text("@\(row.twitterUsername) -> \(row.bskyIdentifier)")
                                    .font(.headline)
                                Text(row.tweetText ?? "(no tweet text)")
                                HStack {
                                    if let twitter = row.twitterUrl, let url = URL(string: twitter) {
                                        Link("Open Twitter", destination: url)
                                    }
                                    if let bsky = row.postUrl, let url = URL(string: bsky) {
                                        Link("Open Bluesky", destination: url)
                                    }
                                    Spacer()
                                    Text("Score: \(row.score, specifier: "%.2f")")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .padding(.vertical, 4)
                            Divider()
                        }
                    }
                }

                GroupBox("Recent Enriched Posts") {
                    if vm.enrichedPosts.isEmpty {
                        Text("No recent posts.")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(vm.enrichedPosts.prefix(60)) { post in
                            VStack(alignment: .leading, spacing: 5) {
                                Text("@\(post.author.handle) | \(post.author.displayName ?? "")")
                                    .font(.headline)
                                Text(post.text)
                                HStack {
                                    Text("Likes \(post.stats.likes)")
                                    Text("Reposts \(post.stats.reposts)")
                                    Text("Replies \(post.stats.replies)")
                                    Text("Quote \(post.stats.quotes)")
                                    Spacer()
                                    if let urlText = post.postUrl, let url = URL(string: urlText) {
                                        Link("Open", destination: url)
                                    }
                                }
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            }
                            .padding(.vertical, 4)
                            Divider()
                        }
                    }
                }
            }
            .padding()
        }
    }

    private var activityTab: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                GroupBox("Recent Activity") {
                    if vm.recentActivity.isEmpty {
                        Text("No recent activity.")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(vm.recentActivity.prefix(200)) { item in
                            VStack(alignment: .leading, spacing: 4) {
                                HStack {
                                    Text("@\(item.twitter_username) -> \(item.bsky_identifier)")
                                        .font(.headline)
                                    Spacer()
                                    Text(item.status)
                                        .font(.caption)
                                        .padding(.horizontal, 8)
                                        .padding(.vertical, 2)
                                        .background(Capsule().fill(.quaternary))
                                }
                                Text(item.tweet_text ?? "(no text)")
                                if let createdAt = item.created_at {
                                    Text(createdAt)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            Divider()
                        }
                    }
                }
            }
            .padding()
        }
    }

    private var settingsTab: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                GroupBox("Connection") {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack {
                            TextField("Host", text: $vm.serverConfig.host)
                                .textFieldStyle(.roundedBorder)
                            TextField("Port", text: $vm.serverConfig.port)
                                .textFieldStyle(.roundedBorder)
                                .frame(width: 100)
                            Toggle("HTTPS", isOn: $vm.serverConfig.useHTTPS)
                        }
                        Text("\(vm.serverConfig.baseURLString)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        HStack {
                            Button("Save") {
                                vm.saveServerConfig()
                            }
                            Button("Test") {
                                Task {
                                    vm.saveServerConfig()
                                    await vm.testConnection()
                                }
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }

                GroupBox("My Account") {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Change Email")
                            .font(.headline)
                        HStack {
                            TextField("Current email", text: $vm.currentEmailInput)
                                .textFieldStyle(.roundedBorder)
                            TextField("New email", text: $vm.newEmailInput)
                                .textFieldStyle(.roundedBorder)
                            SecureField("Password", text: $vm.changeEmailPasswordInput)
                                .textFieldStyle(.roundedBorder)
                            Button("Update Email") {
                                Task { await vm.changeOwnEmail() }
                            }
                        }

                        Divider()

                        Text("Change Password")
                            .font(.headline)
                        HStack {
                            SecureField("Current", text: $vm.currentPasswordInput)
                                .textFieldStyle(.roundedBorder)
                            SecureField("New", text: $vm.newPasswordInput)
                                .textFieldStyle(.roundedBorder)
                            SecureField("Confirm", text: $vm.confirmPasswordInput)
                                .textFieldStyle(.roundedBorder)
                            Button("Update Password") {
                                Task { await vm.changeOwnPassword() }
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }

                if vm.isAdmin {
                    GroupBox("Twitter Settings") {
                        VStack(alignment: .leading, spacing: 10) {
                            TextField("auth_token", text: Binding(
                                get: { vm.twitterConfig.authToken },
                                set: { vm.twitterConfig.authToken = $0 }
                            ))
                            .textFieldStyle(.roundedBorder)
                            TextField("ct0", text: Binding(
                                get: { vm.twitterConfig.ct0 },
                                set: { vm.twitterConfig.ct0 = $0 }
                            ))
                            .textFieldStyle(.roundedBorder)
                            TextField("backup auth_token", text: Binding(
                                get: { vm.twitterConfig.backupAuthToken ?? "" },
                                set: { vm.twitterConfig.backupAuthToken = $0 }
                            ))
                            .textFieldStyle(.roundedBorder)
                            TextField("backup ct0", text: Binding(
                                get: { vm.twitterConfig.backupCt0 ?? "" },
                                set: { vm.twitterConfig.backupCt0 = $0 }
                            ))
                            .textFieldStyle(.roundedBorder)
                            Button("Save Twitter Settings") {
                                Task { await vm.saveTwitterConfig() }
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    GroupBox("AI Settings") {
                        VStack(alignment: .leading, spacing: 10) {
                            TextField("Provider", text: Binding(
                                get: { vm.aiConfig.provider },
                                set: { vm.aiConfig.provider = $0 }
                            ))
                            .textFieldStyle(.roundedBorder)
                            TextField("API key", text: Binding(
                                get: { vm.aiConfig.apiKey ?? "" },
                                set: { vm.aiConfig.apiKey = $0 }
                            ))
                            .textFieldStyle(.roundedBorder)
                            TextField("Model", text: Binding(
                                get: { vm.aiConfig.model ?? "" },
                                set: { vm.aiConfig.model = $0 }
                            ))
                            .textFieldStyle(.roundedBorder)
                            TextField("Base URL", text: Binding(
                                get: { vm.aiConfig.baseUrl ?? "" },
                                set: { vm.aiConfig.baseUrl = $0 }
                            ))
                            .textFieldStyle(.roundedBorder)
                            Button("Save AI Settings") {
                                Task { await vm.saveAIConfig() }
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    GroupBox("Config & Updates") {
                        HStack {
                            Button("Export Config") {
                                Task { await vm.exportConfig() }
                            }
                            Button("Import Config") {
                                Task { await vm.importConfig() }
                            }
                            Button("Run Update") {
                                Task { await vm.runUpdate() }
                            }
                        }
                    }

                    GroupBox("User Management") {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Create User")
                                .font(.headline)
                            HStack {
                                TextField("Username", text: $vm.newUserUsername)
                                    .textFieldStyle(.roundedBorder)
                                TextField("Email", text: $vm.newUserEmail)
                                    .textFieldStyle(.roundedBorder)
                                SecureField("Password", text: $vm.newUserPassword)
                                    .textFieldStyle(.roundedBorder)
                                Toggle("Admin", isOn: $vm.newUserIsAdmin)
                                Button("Create") {
                                    Task { await vm.createUser() }
                                }
                            }

                            Divider()

                            ForEach(vm.managedUsers) { user in
                                VStack(alignment: .leading, spacing: 6) {
                                    HStack {
                                        Text(user.username ?? user.email ?? user.id)
                                            .font(.headline)
                                        if user.isAdmin {
                                            Text("admin")
                                                .font(.caption)
                                                .padding(.horizontal, 6)
                                                .padding(.vertical, 2)
                                                .background(Capsule().fill(.quaternary))
                                        }
                                        Spacer()
                                        Button("Edit") {
                                            vm.beginEditingUser(user)
                                        }
                                        Button("Delete", role: .destructive) {
                                            Task { await vm.deleteUser(userId: user.id) }
                                        }
                                    }

                                    HStack {
                                        SecureField(
                                            "New password",
                                            text: Binding(
                                                get: { resetPasswordDrafts[user.id] ?? "" },
                                                set: { resetPasswordDrafts[user.id] = $0 }
                                            )
                                        )
                                        .textFieldStyle(.roundedBorder)
                                        .frame(maxWidth: 260)

                                        Button("Reset Password") {
                                            let newValue = resetPasswordDrafts[user.id] ?? ""
                                            guard !newValue.isEmpty else { return }
                                            Task {
                                                await vm.resetUserPassword(userId: user.id, newPassword: newValue)
                                                resetPasswordDrafts[user.id] = ""
                                            }
                                        }
                                    }

                                    if vm.editingUser?.id == user.id {
                                        HStack {
                                            TextField("Username", text: $vm.editUserUsername)
                                                .textFieldStyle(.roundedBorder)
                                            TextField("Email", text: $vm.editUserEmail)
                                                .textFieldStyle(.roundedBorder)
                                            Toggle("Admin", isOn: $vm.editUserIsAdmin)
                                            Button("Save") {
                                                Task { await vm.saveEditedUser() }
                                            }
                                            Button("Cancel") {
                                                vm.cancelEditingUser()
                                            }
                                        }
                                    }
                                }
                                Divider()
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            .padding()
        }
    }

    private func statCard(_ title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.title2.bold())
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10).fill(.quaternary.opacity(0.2)))
    }

    private func mappingRow(_ mapping: AccountMapping) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Toggle(
                    isOn: Binding(
                        get: { vm.selectedMappingIDs.contains(mapping.id) },
                        set: { isSelected in
                            if isSelected {
                                vm.selectedMappingIDs.insert(mapping.id)
                            } else {
                                vm.selectedMappingIDs.remove(mapping.id)
                            }
                        }
                    )
                ) {
                    EmptyView()
                }
                .toggleStyle(.checkbox)
                .labelsHidden()

                VStack(alignment: .leading, spacing: 4) {
                    Text(mapping.bskyIdentifier)
                        .font(.headline)
                    Text("Owner: \(mapping.owner ?? "(none)") | Sources: \(mapping.twitterUsernames.joined(separator: ", "))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if mapping.hasBotLabel == true {
                    Text("bot-labeled")
                        .font(.caption)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Capsule().fill(.quaternary))
                }
            }

            HStack {
                Button("Backfill") {
                    Task { await vm.queueBackfill(mappingId: mapping.id) }
                }
                Button("Cancel Queue") {
                    Task { await vm.cancelBackfill(mappingId: mapping.id) }
                }
                Button("Sync Profile") {
                    let source = mapping.profileSyncSourceUsername ?? mapping.twitterUsernames.first ?? ""
                    Task { await vm.syncProfile(mappingId: mapping.id, source: source) }
                }
                Button("Pull Bio") {
                    let source = mapping.profileSyncSourceUsername ?? mapping.twitterUsernames.first ?? ""
                    Task { await vm.pullTwitterBio(mappingId: mapping.id, source: source) }
                }
                Button("Bridge") {
                    Task { await vm.bridgeToFediverse(mappingId: mapping.id) }
                }
                Button("Edit") {
                    vm.beginEditing(mapping: mapping)
                    postsSelection = ""
                    showingEditMappingSheet = true
                }
                Button("Delete", role: .destructive) {
                    Task { await vm.deleteMapping(mappingId: mapping.id) }
                }

                if vm.isAdmin {
                    Button("Clear Cache") {
                        Task { await vm.clearMappingCache(mappingId: mapping.id) }
                    }
                    Button("Delete All Posts", role: .destructive) {
                        Task { await vm.deleteAllPosts(mappingId: mapping.id) }
                    }
                }
            }
            .buttonStyle(.bordered)
        }
    }

    private var editMappingSheet: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Edit Mapping")
                .font(.title3.bold())

            TextField("Owner", text: $vm.editMappingDraft.owner)
                .textFieldStyle(.roundedBorder)
            TextField("Twitter usernames", text: $vm.editMappingDraft.twitterUsernames)
                .textFieldStyle(.roundedBorder)
            TextField("Bluesky identifier", text: $vm.editMappingDraft.bskyIdentifier)
                .textFieldStyle(.roundedBorder)
            SecureField("Bluesky app password (leave empty to keep current)", text: $vm.editMappingDraft.bskyPassword)
                .textFieldStyle(.roundedBorder)
            TextField("Bluesky service URL", text: $vm.editMappingDraft.bskyServiceUrl)
                .textFieldStyle(.roundedBorder)
            HStack {
                TextField("Group name", text: $vm.editMappingDraft.groupName)
                    .textFieldStyle(.roundedBorder)
                TextField("Group emoji", text: $vm.editMappingDraft.groupEmoji)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 80)
            }
            TextField("Profile sync source", text: $vm.editMappingDraft.profileSyncSourceUsername)
                .textFieldStyle(.roundedBorder)

            HStack {
                Spacer()
                Button("Cancel") {
                    vm.cancelEditingMapping()
                    showingEditMappingSheet = false
                }
                Button("Save") {
                    Task {
                        await vm.saveEditedMapping()
                        if vm.selectedMappingForEdit == nil {
                            showingEditMappingSheet = false
                        }
                    }
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .padding()
        .frame(width: 600)
    }

    private func renameGroupSheet(key: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Rename Group")
                .font(.title3.bold())

            TextField("Name", text: $renameGroupName)
                .textFieldStyle(.roundedBorder)
            TextField("Emoji", text: $renameGroupEmoji)
                .textFieldStyle(.roundedBorder)

            HStack {
                Spacer()
                Button("Cancel") {
                    groupToRenameKey = nil
                }
                Button("Save") {
                    Task {
                        await vm.renameGroup(currentKey: key, name: renameGroupName, emoji: renameGroupEmoji)
                        groupToRenameKey = nil
                    }
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .padding()
        .frame(width: 420)
    }

    private var filteredMappings: [AccountMapping] {
        let query = accountsSearch.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !query.isEmpty else { return vm.mappings }

        return vm.mappings.filter { mapping in
            let inOwner = (mapping.owner ?? "").lowercased().contains(query)
            let inBsky = mapping.bskyIdentifier.lowercased().contains(query)
            let inGroup = (mapping.groupName ?? "").lowercased().contains(query)
            let inSources = mapping.twitterUsernames.contains { $0.lowercased().contains(query) }
            return inOwner || inBsky || inGroup || inSources
        }
    }

    private func normalizedGroupKey(_ name: String) -> String {
        name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private func mappingName(id: String) -> String {
        if let mapping = vm.mappings.first(where: { $0.id == id }) {
            return mapping.bskyIdentifier
        }
        return id
    }
}
