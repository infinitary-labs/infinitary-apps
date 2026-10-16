import CryptoKit
import Foundation
import Security
import Testing
@testable import InfinitaryKit

/// INF-64 piece 2: joins use the Mac's link and public-key pin, not an untrusted URL or certificate envelope.
struct TrustTests {
    private struct Fixture: Decodable { let link: String; let pin: String; let certificate: String }
    private func fixture() throws -> Fixture {
        let url = Bundle.module.url(forResource: "home", withExtension: "json", subdirectory: "Fixtures")!
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    @Test func readsMacProducedLinkAndPin() throws {
        let sample = try fixture()
        let link = try JoinLink(sample.link)
        #expect(link.addresses == ["test-mac.local:47623", "192.168.1.20:47623", "[fd00::20]:47623"])
        #expect(link.pin == sample.pin)
        let cert = try #require(SecCertificateCreateWithData(nil, Data(base64Encoded: sample.certificate)! as CFData))
        #expect(PhoneIdentity.pin(of: cert) == sample.pin)
        #expect(try JoinLink.url(link.addresses[0], path: PhoneContract.pairPath).absoluteString == "https://test-mac.local:47623/pair")
    }

    @Test func refusesAmbiguousAndNonDirectLinks() throws {
        let sample = try fixture()
        for text in [sample.link + "&code=another", sample.link + "&unknown=x", sample.link + "#fragment",
                     sample.link.replacingOccurrences(of: "infinitary://", with: "https://"),
                     sample.link.replacingOccurrences(of: "as=mac", with: "as=work"), sample.link + "&via=ssh"] {
            #expect(throws: (any Error).self) { try JoinLink(text) }
        }
        for address in ["test-mac.local:0", "test-mac.local:65536", "user@test-mac.local:47623",
                        "test-mac.local:47623/other", "test-mac.local:47623?query=x", "[::1]:47623#fragment"] {
            #expect(throws: (any Error).self) { try JoinLink.url(address, path: PhoneContract.pairPath) }
        }
    }

    @Test func certificateKeepsPhonePublicKeyAndDoesNotPinTheEnvelope() throws {
        let key = P256.Signing.PrivateKey()
        let first = try PhoneIdentity.certificate(key: key)
        let renewed = try PhoneIdentity.certificate(key: key)
        let other = try PhoneIdentity.certificate(key: .init())
        #expect(PhoneIdentity.pin(of: first) == PhoneIdentity.pin(of: renewed))
        #expect(PhoneIdentity.pin(of: first) != PhoneIdentity.pin(of: other))
        let publicKey = try #require(SecCertificateCopyKey(first))
        #expect(SecKeyCopyExternalRepresentation(publicKey, nil) as Data? == key.publicKey.x963Representation)
    }
}
