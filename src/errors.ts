export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  static badRequest(message: string, details?: unknown): ApiError {
    return new ApiError(400, 'bad_request', message, details);
  }

  static unauthorized(message = 'Invalid or missing API key'): ApiError {
    return new ApiError(401, 'unauthorized', message);
  }

  static forbidden(message: string): ApiError {
    return new ApiError(403, 'forbidden', message);
  }

  static notFound(message = 'Resource not found'): ApiError {
    return new ApiError(404, 'not_found', message);
  }

  static conflict(code: string, message: string, details?: unknown): ApiError {
    return new ApiError(409, code, message, details);
  }

  static tooLarge(message: string, details?: unknown): ApiError {
    return new ApiError(413, 'payload_too_large', message, details);
  }

  static unprocessable(code: string, message: string, details?: unknown): ApiError {
    return new ApiError(422, code, message, details);
  }

  static badGateway(code: string, message: string, details?: unknown): ApiError {
    return new ApiError(502, code, message, details);
  }

  static serviceUnavailable(code: string, message: string, details?: unknown): ApiError {
    return new ApiError(503, code, message, details);
  }
}
