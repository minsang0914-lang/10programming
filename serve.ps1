$ErrorActionPreference = "Stop"
$root = (Resolve-Path $PSScriptRoot).Path
$port = 5173
$address = [Net.IPAddress]::Parse("127.0.0.1")
$listener = [Net.Sockets.TcpListener]::new($address, $port)
$contentTypes = @{
  ".html" = "text/html; charset=utf-8"
  ".js"   = "text/javascript; charset=utf-8"
  ".css"  = "text/css; charset=utf-8"
  ".svg"  = "image/svg+xml"
  ".json" = "application/json; charset=utf-8"
  ".txt"  = "text/plain; charset=utf-8"
}

try {
  $listener.Start()
  $url = "http://127.0.0.1:$port/"
  Write-Host "SVT 실행 중: $url"
  Write-Host "이 창을 닫으면 웹사이트가 종료됩니다."
  Start-Process $url

  while ($true) {
    $client = $listener.AcceptTcpClient()
    try {
      $stream = $client.GetStream()
      $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::ASCII, $false, 1024, $true)
      $requestLine = $reader.ReadLine()
      $headerLine = $reader.ReadLine()
      while ($null -ne $headerLine -and $headerLine -ne "") { $headerLine = $reader.ReadLine() }
      $parts = $requestLine -split " "
      $method = $parts[0]
      $path = if ($parts.Length -gt 1) { ([Uri]::new("http://localhost$($parts[1])")).AbsolutePath } else { "/" }
      $relativePath = [Uri]::UnescapeDataString($path.TrimStart("/")).Replace("/", [IO.Path]::DirectorySeparatorChar)
      if ([string]::IsNullOrWhiteSpace($relativePath)) { $relativePath = "index.html" }
      $target = [IO.Path]::GetFullPath([IO.Path]::Combine($root, $relativePath))
      $rootPrefix = $root.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar

      $status = "200 OK"
      $body = [byte[]]@()
      $mime = "application/octet-stream"
      if ($method -notin @("GET", "HEAD")) {
        $status = "405 Method Not Allowed"
      } elseif ((-not $target.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase) -and $target -ne (Join-Path $root "index.html")) -or -not (Test-Path -LiteralPath $target -PathType Leaf)) {
        $status = "404 Not Found"
      } else {
        $extension = [IO.Path]::GetExtension($target).ToLowerInvariant()
        if ($contentTypes.ContainsKey($extension)) { $mime = $contentTypes[$extension] }
        $body = [IO.File]::ReadAllBytes($target)
      }

      $bodyLength = $body.Length
      $headerText = "HTTP/1.1 $status`r`nContent-Type: $mime`r`nContent-Length: $bodyLength`r`nCache-Control: no-cache`r`nConnection: close`r`n`r`n"
      $header = [Text.Encoding]::ASCII.GetBytes($headerText)
      $stream.Write($header, 0, $header.Length)
      if ($method -ne "HEAD" -and $bodyLength -gt 0) { $stream.Write($body, 0, $bodyLength) }
      $stream.Flush()
    } catch {
      # A browser may close a connection while a response is being written.
    } finally {
      $client.Close()
    }
  }
} catch {
  Write-Host "SVT 서버를 시작하지 못했습니다. 포트 5173이 이미 사용 중인지 확인해 주세요."
  Write-Host $_.Exception.Message
  exit 1
} finally {
  $listener.Stop()
}
