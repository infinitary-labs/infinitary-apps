// swift-tools-version: 6.1
import PackageDescription

let package = Package(
    name: "InfinitaryKit",
    // The phone's words come from the catalog's Apple string files, English first (docs/i18n.md, "On the phone").
    defaultLocalization: "en",
    platforms: [.iOS(.v18), .macOS(.v15)],
    products: [
        .library(name: "InfinitaryKit", targets: ["InfinitaryKit"]),
        // INF-4794: the notification part opens card pushes with this alone (docs/ios.md, "Card pushes").
        .library(name: "InfinitaryPush", targets: ["InfinitaryPush"]),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-certificates.git", exact: "1.21.0"),
        // INF-1183: joining a home by its address signs in over SSH.
        .package(url: "https://github.com/apple/swift-nio-ssh.git", exact: "0.9.1"),
        .package(url: "https://github.com/apple/swift-nio.git", exact: "2.100.0"),
    ],
    targets: [
        .target(name: "InfinitaryPush"),
        .target(name: "InfinitaryKit", dependencies: [
            "InfinitaryPush",
            .product(name: "X509", package: "swift-certificates"),
            .product(name: "NIOSSH", package: "swift-nio-ssh"),
            .product(name: "NIOCore", package: "swift-nio"),
            .product(name: "NIOPosix", package: "swift-nio"),
        ], resources: [.process("Resources")]),
        .testTarget(name: "InfinitaryKitTests", dependencies: ["InfinitaryKit", .product(name: "NIOSSH", package: "swift-nio-ssh"), .product(name: "NIOCore", package: "swift-nio"), .product(name: "NIOPosix", package: "swift-nio")], resources: [.copy("Fixtures")]),
        // INF-4326: the weak-link checks, on the Mac beside the simulated devices; the phone gate's weak-link part runs them
        // against its disposable home, and the package's own tests skip them.
        .testTarget(name: "PhoneWeakLinkTests", dependencies: ["InfinitaryKit"]),
    ]
)
