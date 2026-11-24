# Rate Limiter PowerShell Test Script (Windows 11)
# Sends 7 rapid requests to test Fixed Window Counter Rate Limiting

param(
    [string]$TargetUrl = "http://localhost:3000/api/data"
)

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " Starting Rate Limiter PowerShell Test" -ForegroundColor Cyan
Write-Host " Target Endpoint: $TargetUrl" -ForegroundColor Cyan
Write-Host " Max allowed per window: 5 requests / 60s" -ForegroundColor Cyan
Write-Host " Sending 7 rapid requests..." -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host ""

for ($i = 1; $i -le 7; $i++) {
    Write-Host ">>> [Request #$i] Sending GET $TargetUrl..." -ForegroundColor Yellow
    try {
        $response = Invoke-WebRequest -Uri $TargetUrl -Method Get -UseBasicParsing -ErrorAction Stop
        $status = $response.StatusCode
        $limit = $response.Headers["X-RateLimit-Limit"]
        $remaining = $response.Headers["X-RateLimit-Remaining"]
        $reset = $response.Headers["X-RateLimit-Reset"]
        
        Write-Host "Status               : $status OK" -ForegroundColor Green
        Write-Host "X-RateLimit-Limit    : $limit"
        Write-Host "X-RateLimit-Remaining: $remaining"
        Write-Host "X-RateLimit-Reset    : $reset"
        Write-Host "Body                 : $($response.Content)"
        Write-Host "Result               : PASS (Request Allowed)" -ForegroundColor Green
    }
    catch {
        $statusCode = $_.Exception.Response.StatusCode.value__
        $headers = $_.Exception.Response.Headers
        $stream = $_.Exception.Response.GetResponseStream()
        $reader = New-Object System.IO.StreamReader($stream)
        $body = $reader.ReadToEnd()

        $limit = $headers["X-RateLimit-Limit"]
        $remaining = $headers["X-RateLimit-Remaining"]
        $retryAfter = $headers["Retry-After"]

        Write-Host "Status               : $statusCode Too Many Requests" -ForegroundColor Red
        Write-Host "X-RateLimit-Limit    : $limit"
        Write-Host "X-RateLimit-Remaining: $remaining"
        Write-Host "Retry-After (sec)    : $retryAfter"
        Write-Host "Body                 : $body"
        
        if ($statusCode -eq 429) {
            Write-Host "Result               : PASS (Rate Limit Enforced)" -ForegroundColor Magenta
        } else {
            Write-Host "Result               : UNEXPECTED STATUS ($statusCode)" -ForegroundColor Red
        }
    }
    Write-Host "----------------------------------------------------------"
    Start-Sleep -Milliseconds 200
}

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " Test Execution Completed." -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
