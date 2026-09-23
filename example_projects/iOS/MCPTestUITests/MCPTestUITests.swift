import XCTest

/// Reproduction tests for TEST_RUNNER_ environment variable passthrough.
/// GitHub Issue: https://github.com/getsentry/MobileBuildMCP/issues/101
///
/// Expected behavior:
/// - When invoking xcodebuild test with TEST_RUNNER_USE_DEV_MODE=YES,
///   the test runner environment should contain USE_DEV_MODE=YES
///   (the TEST_RUNNER_ prefix is stripped by xcodebuild).
///
/// Current behavior (before implementation in Node layer):
/// - Running via MobileBuildMCP test tools does not yet pass TEST_RUNNER_
///   variables through, so this test will fail and serve as a repro.
final class MCPTestUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    /// Verifies that USE_DEV_MODE=YES is present in the test runner environment.
    /// This proves TEST_RUNNER_USE_DEV_MODE=YES was passed to xcodebuild.
    func testEnvironmentVariablePassthrough() throws {
        let env = ProcessInfo.processInfo.environment
        let value = env["USE_DEV_MODE"] ?? "<nil>"
        XCTAssertEqual(
            value,
            "YES",
            "Expected USE_DEV_MODE=YES via TEST_RUNNER_USE_DEV_MODE. Actual: \(value)"
        )
    }

    /// Example of how a project might use the env var to alter behavior in dev mode.
    /// This does not change test runner configuration; it simply demonstrates conditional logic.
    func testDevModeBehaviorPlaceholder() throws {
        let isDevMode = ProcessInfo.processInfo.environment["USE_DEV_MODE"] == "YES"
        if isDevMode {
            XCTSkip("Dev mode: skipping heavy or duplicated UI configuration runs")
        }
        XCTAssertTrue(true)
    }
}