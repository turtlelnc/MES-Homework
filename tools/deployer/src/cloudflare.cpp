#include "cloudflare.h"

#include "util.h"

namespace sc {
namespace cf {

namespace {
const char *kApi = "https://api.cloudflare.com/client/v4";

std::vector<std::string> authHeaders(const std::string &apiToken) {
  return {"authorization: Bearer " + apiToken};
}

/// Cloudflare 统一响应：{success, errors:[{code,message}], result:{...}}
Result parseResponse(const HttpResponse &response, const std::string &action) {
  Result result;
  if (!response.started && !response.error.empty()) {
    result.message = response.error;
    return result;
  }
  Json root;
  std::string parseError;
  if (!Json::parse(response.body, root, &parseError)) {
    result.message = action + " 返回内容无法解析：" + parseError;
    if (!response.ok) result.message += "（HTTP " + std::to_string(response.status) + "）";
    return result;
  }
  const Json &success = root["success"];
  if (success.type() == Json::Type::Bool && success.asBool()) {
    result.ok = true;
    result.data = root["result"];
    return result;
  }
  std::string detail;
  const Json &errors = root["errors"];
  for (size_t i = 0; i < errors.size(); ++i) {
    if (i) detail += "；";
    detail += errors.at(i)["message"].toStringOr("未知错误");
  }
  if (detail.empty()) detail = "HTTP " + std::to_string(response.status);
  result.message = action + " 失败：" + detail;
  return result;
}
}  // namespace

Result verifyToken(const std::string &apiToken, std::string &outAccountId) {
  Result result;
  if (apiToken.empty()) {
    result.message = "未提供 Cloudflare API Token";
    return result;
  }
  HttpResponse response = httpGet(std::string(kApi) + "/user/tokens/verify", authHeaders(apiToken));
  Result verified = parseResponse(response, "校验 API Token");
  if (!verified.ok) {
    result.message = verified.message;
    if (verified.message.find("Invalid API Token") != std::string::npos ||
        verified.message.find("1000") != std::string::npos)
      result.message += "（请确认 Token 有效，且具备 Zone:DNS:Edit 权限）";
    return result;
  }
  result.ok = true;
  result.message = "API Token 有效";

  // 取第一个可用账户，用于创建隧道与写入 DNS
  HttpResponse accounts =
      httpGet(std::string(kApi) + "/accounts?per_page=1", authHeaders(apiToken));
  Result accountResult = parseResponse(accounts, "读取账户信息");
  if (accountResult.ok && accountResult.data.size() > 0) {
    outAccountId = accountResult.data.at(0)["id"].toStringOr("");
    const std::string name = accountResult.data.at(0)["name"].toStringOr("");
    if (!name.empty()) result.message += "，账户：" + name;
  }
  return result;
}

Result findZoneId(const std::string &apiToken, const std::string &domain,
                  std::string &outZoneId, std::string &outZoneName) {
  Result result;
  std::string candidate = domain;
  for (int attempt = 0; attempt < 4 && !candidate.empty(); ++attempt) {
    HttpResponse response = httpGet(std::string(kApi) + "/zones?name=" + urlEncode(candidate),
                                    authHeaders(apiToken));
    Result zoneResult = parseResponse(response, "查询 DNS 区域");
    if (zoneResult.ok && zoneResult.data.size() > 0) {
      outZoneId = zoneResult.data.at(0)["id"].toStringOr("");
      outZoneName = zoneResult.data.at(0)["name"].toStringOr(candidate);
      result.ok = true;
      result.data = zoneResult.data.at(0);
      result.message = "已定位 DNS 区域：" + outZoneName;
      return result;
    }
    if (!zoneResult.ok && zoneResult.message.find("失败") != std::string::npos &&
        response.status != 200) {
      result.message = zoneResult.message;
      return result;
    }
    size_t dot = candidate.find('.');
    if (dot == std::string::npos) break;
    candidate = candidate.substr(dot + 1);
  }
  result.message = "没有找到 " + domain + " 所属的 Cloudflare 区域，请确认域名已托管在 Cloudflare";
  return result;
}

namespace {
/// 查找同名记录，返回其 ID（不存在返回空串）。
std::string findRecordId(const std::string &apiToken, const std::string &zoneId,
                         const std::string &recordName) {
  HttpResponse response =
      httpGet(std::string(kApi) + "/zones/" + zoneId + "/dns_records?name=" +
                  urlEncode(recordName),
              authHeaders(apiToken));
  Result found = parseResponse(response, "查询 DNS 记录");
  if (!found.ok || found.data.size() == 0) return "";
  return found.data.at(0)["id"].toStringOr("");
}
}  // namespace

Result upsertTunnelDns(const std::string &apiToken, const std::string &zoneId,
                       const std::string &recordName, const std::string &tunnelId,
                       bool proxied) {
  Result result;
  const std::string content = tunnelId + ".cfargotunnel.com";
  const std::string body = std::string("{\"type\":\"CNAME\",\"name\":\"") +
                           jsonEscape(recordName) + "\",\"content\":\"" + jsonEscape(content) +
                           "\",\"proxied\":" + (proxied ? "true" : "false") + ",\"ttl\":1}";
  const std::string existing = findRecordId(apiToken, zoneId, recordName);
  HttpResponse response;
  if (existing.empty()) {
    response = httpPostJson(std::string(kApi) + "/zones/" + zoneId + "/dns_records", body,
                            authHeaders(apiToken));
    Result created = parseResponse(response, "创建 DNS 记录");
    if (!created.ok) {
      result.message = created.message;
      return result;
    }
    result.ok = true;
    result.message = "已创建 CNAME 记录 " + recordName + " → " + content;
    return result;
  }
  response = httpRequest(std::string(kApi) + "/zones/" + zoneId + "/dns_records/" + existing,
                         "PUT", {"content-type: application/json",
                                 "authorization: Bearer " + apiToken},
                         body);
  Result updated = parseResponse(response, "更新 DNS 记录");
  if (!updated.ok) {
    result.message = updated.message;
    return result;
  }
  result.ok = true;
  result.message = "已更新 CNAME 记录 " + recordName + " → " + content;
  return result;
}

std::string describeDnsRecord(const std::string &apiToken, const std::string &zoneId,
                              const std::string &recordName) {
  HttpResponse response =
      httpGet(std::string(kApi) + "/zones/" + zoneId + "/dns_records?name=" +
                  urlEncode(recordName),
              authHeaders(apiToken));
  Result found = parseResponse(response, "查询 DNS 记录");
  if (!found.ok || found.data.size() == 0) return "";
  return found.data.at(0)["content"].toStringOr("");
}

}  // namespace cf
}  // namespace sc
