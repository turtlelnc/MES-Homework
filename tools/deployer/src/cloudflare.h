// 校园作业分析 · 一键部署器 —— Cloudflare API 封装
// 用于“自定义域名”模式：校验 API Token、定位 DNS 区域、创建/更新指向隧道的 CNAME 记录。
#pragma once

#include <string>
#include <vector>

#include "json.h"

namespace sc {
namespace cf {

struct Result {
  bool ok = false;
  std::string message;   // 失败原因或成功说明
  Json data;             // 接口返回的 result 字段
};

/// 校验 API Token，并返回该 Token 可用的账户 ID。
Result verifyToken(const std::string &apiToken, std::string &outAccountId);

/// 为域名找到所属 DNS 区域 ID（从完整域名逐段去掉子域尝试）。
Result findZoneId(const std::string &apiToken, const std::string &domain,
                  std::string &outZoneId, std::string &outZoneName);

/// 在区域内创建或更新 CNAME 记录，指向 <tunnelId>.cfargotunnel.com。
Result upsertTunnelDns(const std::string &apiToken, const std::string &zoneId,
                       const std::string &recordName, const std::string &tunnelId,
                       bool proxied);

/// 查询已存在记录的备注信息（用于提示用户）。
std::string describeDnsRecord(const std::string &apiToken, const std::string &zoneId,
                              const std::string &recordName);

}  // namespace cf
}  // namespace sc
