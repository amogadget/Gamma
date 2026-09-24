import Foundation

/// Migration-only transport. Never borrows the shared cookie jar or follows a
/// redirect with host credentials; GammaAPI's delegate enforces the exact origin.
extension GammaAPI {
    func localMigrationUpload(data: Data, fileExtension: String, mime: String) async throws -> String {
        guard localServerAccess != nil else { throw APIError.workspaceAccessDenied }
        let reference = try await upload(data: data, fileExtension: fileExtension, mime: mime)
        guard try await asset(reference) == data else {
            throw APIError.message("Migrated asset readback differs from the retained source.")
        }
        return reference
    }

    func localMigrationRequest(_ path: String, method: String = "GET",
                               json: [String: Any]? = nil, pdf: Data? = nil) async throws -> Data {
        guard localServerAccess != nil else { throw APIError.workspaceAccessDenied }
        var request = try makeRequest(path)
        request.httpMethod = method
        if let json {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: json)
        }
        if let pdf {
            let boundary = "GammaMigration-\(UUID().uuidString)"
            request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
            var body = Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"original.pdf\"\r\nContent-Type: application/pdf\r\n\r\n".utf8)
            body.append(pdf); body.append(Data("\r\n--\(boundary)--\r\n".utf8))
            request.httpBody = body
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        let transport = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        defer { transport.invalidateAndCancel() }
        let (data, response) = try await transport.data(for: request)
        try validate(response)
        return data
    }

    func localMigrationPage(_ id: String) async throws -> GammaBlock? {
        // Only a real HTTP 404 means absent; a network/auth/decoding failure never
        // turns into permission to create or overwrite a page.
        guard localServerAccess != nil,
              UUID(uuidString: id)?.uuidString.lowercased() == id else { throw APIError.workspaceAccessDenied }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil; configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil; configuration.urlCache = nil
        let transport = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        defer { transport.invalidateAndCancel() }
        let (data, response) = try await transport.data(for: makeRequest("api/blocks/\(id)/subtree"))
        if (response as? HTTPURLResponse)?.statusCode == 404 { return nil }
        try validate(response)
        struct Tree: Decodable { let block: GammaBlock }
        return try JSONDecoder().decode(Tree.self, from: data).block
    }
}
