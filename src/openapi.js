export function generateOpenApiSpec({ publicBaseUrl = '' } = {}) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'MSuite Nexus API',
      version: '2.0.0',
      description: 'Enterprise GitHub Private Proxy, Binary Artifact Hub & Developer Portal for the MSuite Product Family.',
      contact: {
        name: 'MSuite Core Architecture Team',
      },
    },
    servers: [
      {
        url: publicBaseUrl || '/',
        description: 'MSuite Nexus Proxy Server',
      },
    ],
    components: {
      securitySchemes: {
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'API Key',
          description: 'Client API key (e.g. msk_...) passed as Bearer token',
        },
        ApiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
          description: 'Client API key passed via X-API-Key header',
        },
      },
      schemas: {
        ErrorResponse: {
          type: 'object',
          properties: {
            error: { type: 'string', example: 'unauthorized' },
            message: { type: 'string', example: 'Missing or invalid API key' },
          },
          required: ['error', 'message'],
        },
        ClientIdentity: {
          type: 'object',
          properties: {
            name: { type: 'string', example: 'msuite-sip' },
            repos: { type: 'array', items: { type: 'string' }, example: ['merlinthedev848/MSuite-SIP'] },
            permissions: { type: 'array', items: { type: 'string' }, example: ['releases', 'raw'] },
            allowedIps: { type: 'array', items: { type: 'string' }, example: ['10.0.0.0/8', '127.0.0.1'] },
            expiresAt: { type: 'string', nullable: true, example: '2027-01-01T00:00:00.000Z' },
            rateLimit: { type: 'integer', example: 120 },
          },
        },
        ReleaseAsset: {
          type: 'object',
          properties: {
            id: { type: 'integer', example: 42 },
            name: { type: 'string', example: 'MSuite-Setup-v2.0.0.exe' },
            label: { type: 'string', nullable: true },
            size: { type: 'integer', example: 45281920 },
            content_type: { type: 'string', example: 'application/octet-stream' },
            sha256: { type: 'string', nullable: true, example: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' },
            download_url: { type: 'string', example: '/v1/repos/merlinthedev848/MSuite-SIP/releases/assets/42' },
          },
        },
        ReleasePayload: {
          type: 'object',
          properties: {
            id: { type: 'integer', example: 101 },
            tag_name: { type: 'string', example: 'v2.0.0' },
            name: { type: 'string', example: 'Release v2.0.0' },
            body: { type: 'string' },
            draft: { type: 'boolean' },
            prerelease: { type: 'boolean' },
            created_at: { type: 'string' },
            published_at: { type: 'string' },
            assets: {
              type: 'array',
              items: { $ref: '#/components/schemas/ReleaseAsset' },
            },
          },
        },
      },
    },
    paths: {
      '/health': {
        get: {
          summary: 'Service Health Check',
          description: 'Public liveness probe returning uptime, active clients, and cache status.',
          responses: {
            '200': {
              description: 'Healthy service state',
            },
          },
        },
      },
      '/metrics': {
        get: {
          summary: 'Prometheus Metrics Exposition',
          description: 'Prometheus / OpenMetrics text exposition format (version 0.0.4).',
          responses: {
            '200': {
              description: 'Prometheus telemetry metrics',
              content: { 'text/plain': {} },
            },
          },
        },
      },
      '/openapi.json': {
        get: {
          summary: 'OpenAPI 3.1 Specification',
          description: 'Returns the full OpenAPI specification in JSON format.',
          responses: {
            '200': {
              description: 'OpenAPI 3.1 Document',
              content: { 'application/json': {} },
            },
          },
        },
      },
      '/v1/me': {
        get: {
          summary: 'Verify Client API Key',
          description: 'Returns the authenticated client application name, permissions, and IP guard rules.',
          security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
          responses: {
            '200': {
              description: 'Client identity and scopes',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ClientIdentity' },
                },
              },
            },
            '401': { description: 'Missing or expired key' },
            '403': { description: 'IP forbidden' },
          },
        },
      },
      '/v1/repos/{owner}/{repo}/update': {
        get: {
          summary: 'Check for Software Updates',
          description: 'Checks if a newer release exists compared to `current` semver version for the given channel.',
          security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
          parameters: [
            { name: 'owner', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'repo', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'current', in: 'query', required: true, schema: { type: 'string', example: '1.2.0' } },
            { name: 'channel', in: 'query', schema: { type: 'string', enum: ['stable', 'beta'], default: 'stable' } },
          ],
          responses: {
            '200': { description: 'Update check result and latest release payload' },
            '400': { description: 'Missing current parameter' },
            '403': { description: 'Forbidden for this repository' },
          },
        },
      },
      '/v1/repos/{owner}/{repo}/releases/latest': {
        get: {
          summary: 'Get Latest Release',
          description: 'Retrieves the newest release and proxied binary asset URLs.',
          security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
          parameters: [
            { name: 'owner', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'repo', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'channel', in: 'query', schema: { type: 'string', enum: ['stable', 'beta'] } },
          ],
          responses: {
            '200': {
              description: 'Latest release object with rewritten download URLs',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ReleasePayload' },
                },
              },
            },
          },
        },
      },
      '/v1/repos/{owner}/{repo}/releases/assets/{id}': {
        get: {
          summary: 'Download Release Binary Asset',
          description: 'Streams the release binary directly with local NVMe disk caching and HTTP 206 Range acceleration.',
          security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
          parameters: [
            { name: 'owner', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'repo', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'id', in: 'path', required: true, schema: { type: 'string', example: '42' } },
          ],
          responses: {
            '200': {
              description: 'Full binary stream with X-Checksum-Sha256 and Digest headers',
              content: { 'application/octet-stream': {} },
            },
            '206': {
              description: 'Partial content stream for resumable downloads',
              content: { 'application/octet-stream': {} },
            },
          },
        },
      },
      '/v1/repos/{owner}/{repo}/releases/assets/{id}/digest': {
        get: {
          summary: 'Get Asset Cryptographic Digest',
          description: 'Retrieves SHA-256 hash and metadata for a release asset.',
          security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
          parameters: [
            { name: 'owner', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'repo', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Asset SHA-256 checksum and size' },
          },
        },
      },
      '/v1/repos/{owner}/{repo}/raw/{path}': {
        get: {
          summary: 'Fetch Raw Repository File',
          description: 'Streams a file from a private repository at the specified branch or ref.',
          security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
          parameters: [
            { name: 'owner', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'repo', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'path', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'ref', in: 'query', schema: { type: 'string', default: 'main' } },
          ],
          responses: {
            '200': { description: 'File contents with safe content-type enforcement' },
          },
        },
      },
      '/v1/repos/{owner}/{repo}/archive': {
        get: {
          summary: 'Download Source Archive',
          description: 'Downloads a zipball or tarball of the repository at a specific ref.',
          security: [{ BearerAuth: [] }, { ApiKeyAuth: [] }],
          parameters: [
            { name: 'owner', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'repo', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'ref', in: 'query', schema: { type: 'string', default: 'main' } },
            { name: 'format', in: 'query', schema: { type: 'string', enum: ['zip', 'tar'], default: 'zip' } },
          ],
          responses: {
            '200': { description: 'Archive binary stream' },
          },
        },
      },
      '/v1/webhook': {
        post: {
          summary: 'GitHub Webhook Receiver',
          description: 'Receives GitHub release and push events with optional HMAC-SHA256 signature to invalidate cached entries.',
          parameters: [
            { name: 'X-GitHub-Event', in: 'header', schema: { type: 'string' } },
            { name: 'X-Hub-Signature-256', in: 'header', schema: { type: 'string' } },
          ],
          responses: {
            '200': { description: 'Webhook processed and cache purged' },
            '401': { description: 'Invalid HMAC signature' },
          },
        },
      },
    },
  };
}
