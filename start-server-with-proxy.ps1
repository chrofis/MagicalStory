$port = 8000
$url = "http://localhost:$port/"

Write-Host "Starting web server with API proxy on $url"
Write-Host "Press Ctrl+C to stop"
Write-Host ""

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($url)
$listener.Start()

Write-Host "Server started! Opening browser..."
Start-Process "http://localhost:$port/index.html"

while ($listener.IsListening) {
    $context = $listener.GetContext()
    $request = $context.Request
    $response = $context.Response

    $path = $request.Url.LocalPath
    Write-Host "Request: $path"

    # Handle API proxy requests
    if ($path -eq "/api/generate") {
        try {
            # Read the request body
            $reader = New-Object System.IO.StreamReader($request.InputStream, $request.ContentEncoding)
            $body = $reader.ReadToEnd()
            $reader.Close()

            # Parse JSON to get API key
            $json = $body | ConvertFrom-Json
            $apiKey = $json.apiKey
            $prompt = $json.prompt
            $model = $json.model
            $maxTokens = $json.max_tokens

            # Make request to Anthropic API
            $headers = @{
                "Content-Type" = "application/json"
                "x-api-key" = $apiKey
                "anthropic-version" = "2023-06-01"
            }

            $apiBody = @{
                model = $model
                max_tokens = $maxTokens
                messages = @(
                    @{
                        role = "user"
                        content = $prompt
                    }
                )
            } | ConvertTo-Json -Depth 10

            # Convert to UTF-8 bytes to handle emoji and special characters
            $utf8 = [System.Text.Encoding]::UTF8
            $bodyBytes = $utf8.GetBytes($apiBody)

            Write-Host "Forwarding request to Anthropic API..."
            $apiResponse = Invoke-WebRequest -Uri "https://api.anthropic.com/v1/messages" `
                -Method POST `
                -Headers $headers `
                -Body $bodyBytes `
                -ContentType "application/json; charset=utf-8"

            # Forward response back to browser
            $responseBytes = [System.Text.Encoding]::UTF8.GetBytes($apiResponse.Content)
            $response.ContentType = "application/json; charset=utf-8"
            $response.Headers.Add("Access-Control-Allow-Origin", "*")
            $response.ContentLength64 = $responseBytes.Length
            $response.OutputStream.Write($responseBytes, 0, $responseBytes.Length)
            Write-Host "Response sent successfully"
        }
        catch {
            Write-Host "API Error: $_"
            $errorResponse = @{
                error = @{
                    message = $_.Exception.Message
                }
            } | ConvertTo-Json
            $errorBytes = [System.Text.Encoding]::UTF8.GetBytes($errorResponse)
            $response.StatusCode = 500
            $response.ContentType = "application/json; charset=utf-8"
            $response.Headers.Add("Access-Control-Allow-Origin", "*")
            $response.ContentLength64 = $errorBytes.Length
            $response.OutputStream.Write($errorBytes, 0, $errorBytes.Length)
        }
        $response.Close()
        continue
    }

    # Handle OPTIONS preflight requests for CORS
    if ($request.HttpMethod -eq "OPTIONS") {
        $response.Headers.Add("Access-Control-Allow-Origin", "*")
        $response.Headers.Add("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        $response.Headers.Add("Access-Control-Allow-Headers", "Content-Type")
        $response.StatusCode = 200
        $response.Close()
        continue
    }

    # Handle file requests
    if ($path -eq "/") { $path = "/index.html" }
    $filePath = Join-Path $PSScriptRoot $path.TrimStart('/')

    if (Test-Path $filePath) {
        $content = [System.IO.File]::ReadAllBytes($filePath)

        # Set content type based on extension
        $ext = [System.IO.Path]::GetExtension($filePath)
        switch ($ext) {
            ".html" { $response.ContentType = "text/html; charset=utf-8" }
            ".js"   { $response.ContentType = "application/javascript; charset=utf-8" }
            ".css"  { $response.ContentType = "text/css; charset=utf-8" }
            ".json" { $response.ContentType = "application/json; charset=utf-8" }
            default { $response.ContentType = "application/octet-stream" }
        }

        $response.ContentLength64 = $content.Length
        $response.OutputStream.Write($content, 0, $content.Length)
    } else {
        $response.StatusCode = 404
        $buffer = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found")
        $response.ContentLength64 = $buffer.Length
        $response.OutputStream.Write($buffer, 0, $buffer.Length)
    }

    $response.Close()
}

$listener.Stop()
