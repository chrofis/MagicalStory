$port = 8000
$url = "http://localhost:$port/"

Write-Host "Starting web server on $url"
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
    if ($path -eq "/") { $path = "/index.html" }

    $filePath = Join-Path $PSScriptRoot $path.TrimStart('/')

    Write-Host "Request: $path"

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
