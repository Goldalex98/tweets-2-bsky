import XCTest
@testable import Tweets2BskyMac

final class Tweets2BskyMacTests: XCTestCase {
    func testServerConfigDefaults() {
        let config = ServerConfig.default
        XCTAssertEqual(config.normalizedHost, "127.0.0.1")
        XCTAssertEqual(config.normalizedPort, "3000")
        XCTAssertEqual(config.baseURLString, "http://127.0.0.1:3000")
    }

    func testServerConfigNormalization() {
        let config = ServerConfig(host: " 100.64.0.10 ", port: " ", useHTTPS: true)
        XCTAssertEqual(config.normalizedHost, "100.64.0.10")
        XCTAssertEqual(config.normalizedPort, "3000")
        XCTAssertEqual(config.baseURLString, "https://100.64.0.10:3000")
    }

    func testMappingDraftParsesTwitterUsernames() {
        var draft = MappingDraft()
        draft.twitterUsernames = "@alpha, beta gamma\n@delta"
        XCTAssertEqual(draft.twitterUsernameList, ["alpha", "beta", "gamma", "delta"])
    }
}
