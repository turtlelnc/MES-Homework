import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { api } from "./api";
type Capabilities = { stages: string[]; publicRegistration: boolean };
const Context = createContext<Capabilities | null>(null);
export function CapabilitiesProvider({ children }: { children: ReactNode }) {
  const [value, setValue] = useState<Capabilities | null>(null),
    [error, setError] = useState("");
  const load = () =>
    api<Capabilities>("/capabilities")
      .then(setValue)
      .catch((e) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);
  if (!value)
    return (
      <div className="auth-shell">
        <p>{error || "正在读取服务配置…"}</p>
        {error && (
          <button
            onClick={() => {
              setError("");
              void load();
            }}
          >
            重新连接
          </button>
        )}
      </div>
    );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useCapabilities() {
  const value = useContext(Context);
  if (!value) throw new Error("服务配置尚未加载");
  return value;
}
