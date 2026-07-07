import Foundation

enum HTTPMethod: String {
    case get = "GET"
    case post = "POST"
    case put = "PUT"
    case delete = "DELETE"
}

struct APIErrorEnvelope: Decodable {
    let error: String?
    let message: String?
}

enum APIClientError: LocalizedError {
    case invalidBaseURL
    case invalidResponse
    case serverError(String)
    case unauthorized

    var errorDescription: String? {
        switch self {
        case .invalidBaseURL:
            return "Invalid server URL. Check host/port settings."
        case .invalidResponse:
            return "Server returned an invalid response."
        case .serverError(let message):
            return message
        case .unauthorized:
            return "Your session expired. Please sign in again."
        }
    }
}

struct AnyEncodable: Encodable {
    private let encodeBlock: (Encoder) throws -> Void

    init<T: Encodable>(_ wrapped: T) {
        self.encodeBlock = wrapped.encode
    }

    func encode(to encoder: Encoder) throws {
        try encodeBlock(encoder)
    }
}

actor APIClient {
    private let session: URLSession
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    private var serverConfig: ServerConfig
    private var token: String?

    init(serverConfig: ServerConfig, token: String? = nil, session: URLSession = .shared) {
        self.serverConfig = serverConfig
        self.token = token
        self.session = session
        self.encoder = JSONEncoder()
        self.decoder = JSONDecoder()
    }

    func updateServerConfig(_ serverConfig: ServerConfig) {
        self.serverConfig = serverConfig
    }

    func updateToken(_ token: String?) {
        self.token = token
    }

    func request<T: Decodable>(
        _ path: String,
        method: HTTPMethod = .get,
        queryItems: [URLQueryItem] = [],
        jsonBody: Encodable? = nil,
        bodyData: Data? = nil,
        requiresAuth: Bool = true
    ) async throws -> T {
        guard var components = URLComponents(string: serverConfig.baseURLString) else {
            throw APIClientError.invalidBaseURL
        }

        let normalizedPath = path.hasPrefix("/") ? path : "/\(path)"
        components.path = normalizedPath
        if !queryItems.isEmpty {
            components.queryItems = queryItems
        }

        guard let url = components.url else {
            throw APIClientError.invalidBaseURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = method.rawValue
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        if requiresAuth {
            guard let token, !token.isEmpty else {
                throw APIClientError.unauthorized
            }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        if let jsonBody {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            let boxed = AnyEncodable(jsonBody)
            request.httpBody = try encoder.encode(boxed)
        } else if let bodyData {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = bodyData
        }

        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIClientError.invalidResponse
        }

        if httpResponse.statusCode == 401 || httpResponse.statusCode == 403 {
            throw APIClientError.unauthorized
        }

        guard (200...299).contains(httpResponse.statusCode) else {
            if let envelope = try? decoder.decode(APIErrorEnvelope.self, from: data),
               let message = envelope.error ?? envelope.message,
               !message.isEmpty {
                throw APIClientError.serverError(message)
            }

            if let text = String(data: data, encoding: .utf8), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                throw APIClientError.serverError(text)
            }

            throw APIClientError.serverError("Request failed with status \(httpResponse.statusCode).")
        }

        if T.self == EmptyResponse.self {
            return EmptyResponse() as! T
        }

        return try decoder.decode(T.self, from: data)
    }

    func requestData(
        _ path: String,
        method: HTTPMethod = .get,
        queryItems: [URLQueryItem] = [],
        jsonBody: Encodable? = nil,
        bodyData: Data? = nil,
        requiresAuth: Bool = true
    ) async throws -> Data {
        guard var components = URLComponents(string: serverConfig.baseURLString) else {
            throw APIClientError.invalidBaseURL
        }

        let normalizedPath = path.hasPrefix("/") ? path : "/\(path)"
        components.path = normalizedPath
        if !queryItems.isEmpty {
            components.queryItems = queryItems
        }

        guard let url = components.url else {
            throw APIClientError.invalidBaseURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = method.rawValue
        request.timeoutInterval = 20

        if requiresAuth {
            guard let token, !token.isEmpty else {
                throw APIClientError.unauthorized
            }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        if let jsonBody {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            let boxed = AnyEncodable(jsonBody)
            request.httpBody = try encoder.encode(boxed)
        } else if let bodyData {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = bodyData
        }

        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIClientError.invalidResponse
        }

        if httpResponse.statusCode == 401 || httpResponse.statusCode == 403 {
            throw APIClientError.unauthorized
        }

        guard (200...299).contains(httpResponse.statusCode) else {
            if let envelope = try? decoder.decode(APIErrorEnvelope.self, from: data),
               let message = envelope.error ?? envelope.message,
               !message.isEmpty {
                throw APIClientError.serverError(message)
            }

            throw APIClientError.serverError("Request failed with status \(httpResponse.statusCode).")
        }

        return data
    }
}
