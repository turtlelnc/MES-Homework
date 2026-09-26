// JSON 解析器验证：用真实的 Cloudflare / cloudflared 响应形态测试 deployer 的解析实现。
#include <iostream>
#include <string>

#include "../src/json.h"
#include "../src/util.h"

using namespace sc;

static int failures = 0;

void check(const std::string &label, bool condition, const std::string &detail = "") {
  std::cout << (condition ? "PASS  " : "FAIL  ") << label;
  if (!detail.empty()) std::cout << "  →  " << detail;
  std::cout << "\n";
  if (!condition) ++failures;
}

int main() {
  // 1) 无效 Token（含嵌套 error_chain 的数组结构）
  {
    const std::string text =
        R"({"success":false,"errors":[{"code":6003,"message":"Invalid request headers","error_chain":[{"code":6111,"message":"Invalid format for Authorization header"}]}],"messages":[],"result":null})";
    Json root;
    std::string error;
    check("解析无效 Token 响应", Json::parse(text, root, &error), error);
    check("success 字段为 false",
          root["success"].type() == Json::Type::Bool && !root["success"].asBool());
    check("能取到嵌套错误信息",
          root["errors"].at(0)["message"].toStringOr("") == "Invalid request headers",
          root["errors"].at(0)["message"].asString());
    check("能取到 error_chain 二级错误",
          root["errors"].at(0)["error_chain"].at(0)["message"].toStringOr("") ==
              "Invalid format for Authorization header");
    check("result 为 null", root["result"].isNull());
  }

  // 2) Token 校验成功
  {
    const std::string text =
        R"({"result":{"id":"abc123","status":"active"},"success":true,"errors":[],"messages":[]})";
    Json root;
    check("解析成功响应", Json::parse(text, root, nullptr));
    check("success 为 true", root["success"].asBool());
    check("路径取值 result.id", root.path("result.id").toStringOr("") == "abc123");
  }

  // 3) 账户列表（数组 + 中文名，验证 UTF-8 透传）
  {
    const std::string text =
        R"({"result":[{"id":"acc-1","name":"梅沙教育"}],"success":true,"errors":[],"messages":[]})";
    Json root;
    check("解析账户列表", Json::parse(text, root, nullptr));
    check("数组长度", root["result"].size() == 1);
    check("账户 ID", root["result"].at(0)["id"].toStringOr("") == "acc-1");
    check("中文名称未被破坏",
          root["result"].at(0)["name"].toStringOr("") == "梅沙教育",
          root["result"].at(0)["name"].asString());
  }

  // 4) DNS 区域查询返回空数组（域名未托管在 Cloudflare 的情形）
  {
    const std::string text = R"({"result":[],"success":true,"errors":[],"messages":[]})";
    Json root;
    check("解析空结果", Json::parse(text, root, nullptr));
    check("空数组长度为 0", root["result"].size() == 0);
    check("越界取值安全", root["result"].at(5).isNull());
    check("缺失键安全", root["result"].at(0)["nothing"].isNull());
  }

  // 5) 转义字符（Cloudflare 消息里可能出现引号与换行）
  {
    const std::string text =
        R"({"success":false,"errors":[{"message":"Token \"cf\" 已过期\n请重新生成"}]})";
    Json root;
    check("解析含转义的消息", Json::parse(text, root, nullptr));
    check("转义还原正确",
          root["errors"].at(0)["message"].toStringOr("") == "Token \"cf\" 已过期\n请重新生成",
          root["errors"].at(0)["message"].asString());
  }

  // 6) 隧道凭证文件（cloudflared 写出的 JSON）
  {
    const std::string text =
        R"({"AccountTag":"acc","TunnelSecret":"secret","TunnelID":"2f0f9b3a-1111-2222-3333-444455556666","Endpoint":""})";
    Json root;
    check("解析隧道凭证", Json::parse(text, root, nullptr));
    check("读取 TunnelID",
          root["TunnelID"].toStringOr("") == "2f0f9b3a-1111-2222-3333-444455556666");
  }

  // 7) 破损输入必须被拒绝而不是崩溃
  {
    Json root;
    std::string error;
    check("拒绝截断的 JSON", !Json::parse(R"({"success":tr)", root, &error));
    check("拒绝非法字面量", !Json::parse(R"({"a":trux})", root, &error));
    check("拒绝多余内容", !Json::parse(R"({"a":1} trailing)", root, &error));
    check("错误信息包含位置提示", error.find("位置") != std::string::npos, error);
  }

  // 8) 数字类型（端口等）
  {
    Json root;
    check("解析数字", Json::parse(R"({"port":8787,"ratio":0.875})", root, nullptr));
    check("整数值", (int)root["port"].asNumber() == 8787);
    check("小数值", root["ratio"].asNumber() > 0.87 && root["ratio"].asNumber() < 0.88);
  }

  std::cout << "\n" << (failures ? std::to_string(failures) + " 项失败" : "全部通过") << "\n";
  return failures ? 1 : 0;
}
