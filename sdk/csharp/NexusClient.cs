using System;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace MSuite.Nexus
{
    /// <summary>
    /// Official MSuite Nexus Client for .NET (WPF, WinForms, Avalonia, MAUI, ASP.NET).
    /// Provides zero-dependency, secure binary distribution and auto-update verification.
    /// </summary>
    public class NexusClient : IDisposable
    {
        private readonly HttpClient _http;
        private readonly string _baseUrl;

        public NexusClient(string baseUrl = null, string apiKey = null, HttpClient httpClient = null)
        {
            _baseUrl = (baseUrl ?? Environment.GetEnvironmentVariable("MSUITE_NEXUS_URL") ?? "http://localhost:8080").TrimEnd('/');
            _http = httpClient ?? new HttpClient();

            _http.DefaultRequestHeaders.UserAgent.Clear();
            _http.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("MSuite-Nexus-Client", "2.0"));

            var key = apiKey ?? Environment.GetEnvironmentVariable("MSUITE_NEXUS_KEY");
            if (!string.IsNullOrWhiteSpace(key))
            {
                _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", key.Trim());
            }
        }

        public async Task<JsonElement> CheckForUpdateAsync(string repo, string currentVersion, string channel = "stable", CancellationToken ct = default)
        {
            var parts = repo.Split('/');
            var url = $"{_baseUrl}/v1/repos/{Uri.EscapeDataString(parts[0])}/{Uri.EscapeDataString(parts[1])}/update?current={Uri.EscapeDataString(currentVersion)}&channel={channel}";
            var response = await _http.GetAsync(url, ct);
            response.EnsureSuccessStatusCode();
            var json = await response.Content.ReadAsStringAsync(ct);
            return JsonDocument.Parse(json).RootElement;
        }

        public async Task<string> DownloadAssetAsync(string repo, long assetId, string destFilePath, IProgress<(long Downloaded, long Total)> progress = null, CancellationToken ct = default)
        {
            var parts = repo.Split('/');
            var url = $"{_baseUrl}/v1/repos/{Uri.EscapeDataString(parts[0])}/{Uri.EscapeDataString(parts[1])}/releases/assets/{assetId}";

            using var response = await _http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, ct);
            response.EnsureSuccessStatusCode();

            string expectedSha256 = null;
            if (response.Headers.TryGetValues("X-Checksum-Sha256", out var shaVals))
            {
                expectedSha256 = string.Join("", shaVals).Trim();
            }

            var totalBytes = response.Content.Headers.ContentLength ?? -1L;
            var tempPath = destFilePath + ".tmp." + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

            var dir = Path.GetDirectoryName(destFilePath);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
            {
                Directory.CreateDirectory(dir);
            }

            using (var contentStream = await response.Content.ReadAsStreamAsync(ct))
            using (var fileStream = new FileStream(tempPath, FileMode.Create, FileAccess.Write, FileShare.None, 8192, true))
            using (var sha256 = SHA256.Create())
            {
                var buffer = new byte[8192];
                long totalRead = 0;
                int bytesRead;

                while ((bytesRead = await contentStream.ReadAsync(buffer, 0, buffer.Length, ct)) > 0)
                {
                    await fileStream.WriteAsync(buffer, 0, bytesRead, ct);
                    sha256.TransformBlock(buffer, 0, bytesRead, null, 0);
                    totalRead += bytesRead;
                    progress?.Report((totalRead, totalBytes));
                }

                sha256.TransformFinalBlock(Array.Empty<byte>(), 0, 0);
                var actualSha256 = BitConverter.ToString(sha256.Hash).Replace("-", "").ToLowerInvariant();

                if (!string.IsNullOrEmpty(expectedSha256) && !string.Equals(actualSha256, expectedSha256, StringComparison.OrdinalIgnoreCase))
                {
                    fileStream.Close();
                    File.Delete(tempPath);
                    throw new InvalidOperationException($"SHA-256 Checksum Mismatch! Expected {expectedSha256}, got {actualSha256}");
                }
            }

            if (File.Exists(destFilePath)) File.Delete(destFilePath);
            File.Move(tempPath, destFilePath);
            return destFilePath;
        }

        public async Task<string> CallServiceAsync(string serviceId, string subPath = "", HttpMethod method = null, HttpContent content = null, CancellationToken ct = default)
        {
            var cleanSub = string.IsNullOrEmpty(subPath) ? "" : "/" + subPath.TrimStart('/');
            var url = $"{_baseUrl}/v1/services/{Uri.EscapeDataString(serviceId)}{cleanSub}";

            var request = new HttpRequestMessage(method ?? HttpMethod.Get, url);
            if (content != null) request.Content = content;

            var response = await _http.SendAsync(request, ct);
            response.EnsureSuccessStatusCode();
            return await response.Content.ReadAsStringAsync(ct);
        }

        public async Task<JsonElement> PublishMessageAsync(string topic, object payload, CancellationToken ct = default)
        {
            var url = $"{_baseUrl}/v1/bus/publish";
            var body = JsonSerializer.Serialize(new { topic, payload });
            var content = new StringContent(body, System.Text.Encoding.UTF8, "application/json");

            var response = await _http.PostAsync(url, content, ct);
            response.EnsureSuccessStatusCode();
            var json = await response.Content.ReadAsStringAsync(ct);
            return JsonDocument.Parse(json).RootElement;
        }

        public void Dispose()
        {
            _http?.Dispose();
        }
    }
}
