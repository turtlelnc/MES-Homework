#include "json.h"

#include <cctype>
#include <cstdlib>
#include <sstream>

namespace sc {

const Json &Json::nullNode() {
  static const Json node;
  return node;
}

const Json &Json::operator[](const std::string &key) const {
  auto found = members_.find(key);
  return found == members_.end() ? nullNode() : found->second;
}

const Json &Json::at(size_t index) const {
  return index < items_.size() ? items_[index] : nullNode();
}

const Json &Json::path(const std::string &dotted) const {
  const Json *current = this;
  std::stringstream stream(dotted);
  std::string segment;
  while (std::getline(stream, segment, '.')) {
    if (segment.empty()) continue;
    if (current->type_ == Type::Object) {
      current = &(*current)[segment];
    } else if (current->type_ == Type::Array) {
      try {
        current = &current->at((size_t)std::stoul(segment));
      } catch (...) {
        return nullNode();
      }
    } else {
      return nullNode();
    }
  }
  return *current;
}

class JsonParser {
 public:
  JsonParser(const std::string &text, std::string *error)
      : text_(text), error_(error) {}

  bool run(Json &out) {
    skipWhitespace();
    if (!parseValue(out)) return false;
    skipWhitespace();
    if (position_ != text_.size()) return fail("JSON 结尾存在多余内容");
    return true;
  }

 private:
  const std::string &text_;
  std::string *error_;
  size_t position_ = 0;

  bool fail(const std::string &message) {
    if (error_) {
      std::ostringstream out;
      out << message << "（位置 " << position_ << "）";
      *error_ = out.str();
    }
    return false;
  }

  void skipWhitespace() {
    while (position_ < text_.size() &&
           std::isspace((unsigned char)text_[position_]))
      ++position_;
  }

  bool literal(const char *word) {
    size_t length = std::char_traits<char>::length(word);
    if (text_.compare(position_, length, word) != 0) return false;
    position_ += length;
    return true;
  }

  bool parseValue(Json &out) {
    if (position_ >= text_.size()) return fail("意外结束");
    char ch = text_[position_];
    switch (ch) {
      case '{': return parseObject(out);
      case '[': return parseArray(out);
      case '"': {
        out.type_ = Json::Type::String;
        return parseString(out.string_);
      }
      case 't':
        if (!literal("true")) return fail("无效的字面量");
        out.type_ = Json::Type::Bool;
        out.boolean_ = true;
        return true;
      case 'f':
        if (!literal("false")) return fail("无效的字面量");
        out.type_ = Json::Type::Bool;
        out.boolean_ = false;
        return true;
      case 'n':
        if (!literal("null")) return fail("无效的字面量");
        out.type_ = Json::Type::Null;
        return true;
      default: return parseNumber(out);
    }
  }

  bool parseObject(Json &out) {
    out.type_ = Json::Type::Object;
    ++position_;  // {
    skipWhitespace();
    if (position_ < text_.size() && text_[position_] == '}') {
      ++position_;
      return true;
    }
    for (;;) {
      skipWhitespace();
      if (position_ >= text_.size() || text_[position_] != '"')
        return fail("对象键必须是字符串");
      std::string key;
      if (!parseString(key)) return false;
      skipWhitespace();
      if (position_ >= text_.size() || text_[position_] != ':')
        return fail("对象缺少冒号");
      ++position_;
      skipWhitespace();
      Json value;
      if (!parseValue(value)) return false;
      out.members_[key] = value;
      skipWhitespace();
      if (position_ < text_.size() && text_[position_] == ',') {
        ++position_;
        continue;
      }
      if (position_ < text_.size() && text_[position_] == '}') {
        ++position_;
        return true;
      }
      return fail("对象缺少逗号或右括号");
    }
  }

  bool parseArray(Json &out) {
    out.type_ = Json::Type::Array;
    ++position_;  // [
    skipWhitespace();
    if (position_ < text_.size() && text_[position_] == ']') {
      ++position_;
      return true;
    }
    for (;;) {
      skipWhitespace();
      Json value;
      if (!parseValue(value)) return false;
      out.items_.push_back(value);
      skipWhitespace();
      if (position_ < text_.size() && text_[position_] == ',') {
        ++position_;
        continue;
      }
      if (position_ < text_.size() && text_[position_] == ']') {
        ++position_;
        return true;
      }
      return fail("数组缺少逗号或右括号");
    }
  }

  bool parseString(std::string &out) {
    if (text_[position_] != '"') return fail("字符串缺少引号");
    ++position_;
    out.clear();
    while (position_ < text_.size()) {
      char ch = text_[position_++];
      if (ch == '"') return true;
      if (ch != '\\') {
        out.push_back(ch);
        continue;
      }
      if (position_ >= text_.size()) break;
      char escape = text_[position_++];
      switch (escape) {
        case '"': out.push_back('"'); break;
        case '\\': out.push_back('\\'); break;
        case '/': out.push_back('/'); break;
        case 'b': out.push_back('\b'); break;
        case 'f': out.push_back('\f'); break;
        case 'n': out.push_back('\n'); break;
        case 'r': out.push_back('\r'); break;
        case 't': out.push_back('\t'); break;
        case 'u': {
          if (position_ + 4 > text_.size()) return fail("\\u 转义不完整");
          unsigned code = 0;
          for (int i = 0; i < 4; ++i) {
            char digit = text_[position_++];
            code <<= 4;
            if (digit >= '0' && digit <= '9') code |= (unsigned)(digit - '0');
            else if (digit >= 'a' && digit <= 'f') code |= (unsigned)(digit - 'a' + 10);
            else if (digit >= 'A' && digit <= 'F') code |= (unsigned)(digit - 'A' + 10);
            else return fail("无效的 \\u 转义");
          }
          // UTF-16 -> UTF-8（暂不处理代理对，Cloudflare 返回内容用不到）
          if (code < 0x80) {
            out.push_back((char)code);
          } else if (code < 0x800) {
            out.push_back((char)(0xC0 | (code >> 6)));
            out.push_back((char)(0x80 | (code & 0x3F)));
          } else {
            out.push_back((char)(0xE0 | (code >> 12)));
            out.push_back((char)(0x80 | ((code >> 6) & 0x3F)));
            out.push_back((char)(0x80 | (code & 0x3F)));
          }
          break;
        }
        default: return fail("未知转义字符");
      }
    }
    return fail("字符串未闭合");
  }

  bool parseNumber(Json &out) {
    size_t begin = position_;
    if (position_ < text_.size() && (text_[position_] == '-' || text_[position_] == '+'))
      ++position_;
    bool digits = false;
    while (position_ < text_.size() &&
           (std::isdigit((unsigned char)text_[position_]) || text_[position_] == '.' ||
            text_[position_] == 'e' || text_[position_] == 'E' || text_[position_] == '+' ||
            text_[position_] == '-')) {
      if (std::isdigit((unsigned char)text_[position_])) digits = true;
      ++position_;
    }
    if (!digits) {
      position_ = begin;
      return fail("不是有效的 JSON 值");
    }
    out.type_ = Json::Type::Number;
    out.number_ = std::strtod(text_.substr(begin, position_ - begin).c_str(), nullptr);
    return true;
  }
};

bool Json::parse(const std::string &text, Json &out, std::string *error) {
  JsonParser parser(text, error);
  return parser.run(out);
}

}  // namespace sc
