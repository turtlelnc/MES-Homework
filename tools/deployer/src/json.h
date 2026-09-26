// 校园作业分析 · 一键部署器 —— 极简 JSON 解析
// 只实现部署所需能力：对象、数组、字符串、数字、布尔、null，以及路径取值。
#pragma once

#include <map>
#include <memory>
#include <string>
#include <vector>

namespace sc {

class Json {
 public:
  enum class Type { Null, Bool, Number, String, Array, Object };

  Json() = default;

  static bool parse(const std::string &text, Json &out, std::string *error = nullptr);

  Type type() const { return type_; }
  bool isNull() const { return type_ == Type::Null; }
  bool isObject() const { return type_ == Type::Object; }
  bool isArray() const { return type_ == Type::Array; }
  bool isString() const { return type_ == Type::String; }
  bool isNumber() const { return type_ == Type::Number; }

  const std::string &asString() const { return string_; }
  double asNumber() const { return number_; }
  bool asBool() const { return boolean_; }

  /// 对象取值；不存在返回 Null 节点。
  const Json &operator[](const std::string &key) const;
  /// 数组取值；越界返回 Null 节点。
  const Json &at(size_t index) const;
  size_t size() const { return items_.size(); }

  /// 按 "result.id" 这样的路径取值，任一层缺失即返回 Null。
  const Json &path(const std::string &dotted) const;

  std::string toStringOr(const std::string &fallback = "") const {
    return type_ == Type::String ? string_ : fallback;
  }

 private:
  Type type_ = Type::Null;
  bool boolean_ = false;
  double number_ = 0;
  std::string string_;
  std::vector<Json> items_;                       // Array
  std::map<std::string, Json> members_;           // Object

  static const Json &nullNode();
  friend class JsonParser;
};

}  // namespace sc
