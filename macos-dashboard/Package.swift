// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "macos-dashboard",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "Tweets2BskyMac", targets: ["Tweets2BskyMac"])
    ],
    targets: [
        .executableTarget(
            name: "Tweets2BskyMac"
        ),
        .testTarget(
            name: "Tweets2BskyMacTests",
            dependencies: ["Tweets2BskyMac"]
        )
    ]
)
