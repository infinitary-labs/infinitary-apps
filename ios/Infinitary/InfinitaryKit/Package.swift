// swift-tools-version: 6.1
import PackageDescription

let package = Package(
    name: "InfinitaryKit",
    platforms: [.iOS(.v18), .macOS(.v15)],
    products: [.library(name: "InfinitaryKit", targets: ["InfinitaryKit"])],
    dependencies: [.package(url: "https://github.com/apple/swift-certificates.git", exact: "1.21.0")],
    targets: [
        .target(name: "InfinitaryKit", dependencies: [.product(name: "X509", package: "swift-certificates")]),
        .testTarget(name: "InfinitaryKitTests", dependencies: ["InfinitaryKit"], resources: [.copy("Fixtures")]),
    ]
)
