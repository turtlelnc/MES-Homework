// No installer UI: MSI owns installation. This small native executable starts
// the bundled runtime and implements the optional Windows service protocol.
#include <windows.h>
#include <shellapi.h>
#include <filesystem>
#include <string>
#include <vector>
#include <atomic>

namespace {
SERVICE_STATUS_HANDLE serviceHandle = nullptr;
SERVICE_STATUS status{};
std::atomic<HANDLE> serviceInput{INVALID_HANDLE_VALUE};
std::atomic<ULONGLONG> stopAt{0};
const wchar_t* serviceName = L"MESHomework";

std::wstring quote(const std::wstring& value) {
  std::wstring out=L"\"";size_t slashes=0;
  for(wchar_t ch:value){if(ch==L'\\'){slashes++;continue;}
    out.append(slashes*(ch==L'"'?2:1),L'\\');slashes=0;
    if(ch==L'"')out+=L'\\';out+=ch;
  }
  out.append(slashes*2,L'\\');return out+L'"';
}
std::wstring environment(const wchar_t* name) {
  const DWORD count=GetEnvironmentVariableW(name,nullptr,0);
  if(!count)return {};
  std::vector<wchar_t> buffer(count);GetEnvironmentVariableW(name,buffer.data(),count);return buffer.data();
}
void report(DWORD state,DWORD exitCode=NO_ERROR) {
  if(!serviceHandle)return;
  status.dwServiceType=SERVICE_WIN32_OWN_PROCESS;status.dwCurrentState=state;
  status.dwControlsAccepted=state==SERVICE_RUNNING ? SERVICE_ACCEPT_STOP|SERVICE_ACCEPT_SHUTDOWN : 0;
  status.dwWin32ExitCode=exitCode;status.dwWaitHint=state==SERVICE_STOP_PENDING?20000:0;
  status.dwCheckPoint=state==SERVICE_STOP_PENDING?1:0;SetServiceStatus(serviceHandle,&status);
}
DWORD WINAPI control(DWORD code,DWORD,LPVOID,LPVOID) {
  if(code==SERVICE_CONTROL_STOP || code==SERVICE_CONTROL_SHUTDOWN){
    report(SERVICE_STOP_PENDING);stopAt=GetTickCount64();
    HANDLE pipe=serviceInput.load();DWORD bytes;
    if(pipe!=INVALID_HANDLE_VALUE)WriteFile(pipe,"stop\n",5,&bytes,nullptr);
  }else if(code==SERVICE_CONTROL_INTERROGATE)report(status.dwCurrentState);
  return NO_ERROR;
}
int run(bool service,const std::vector<std::wstring>& arguments) {
  std::vector<wchar_t> filename(32768);
  DWORD length=GetModuleFileNameW(nullptr,filename.data(),static_cast<DWORD>(filename.size()));
  if(!length || length>=filename.size())return 2;
  const auto root=std::filesystem::path(filename.data()).parent_path();
  const auto node=root/L"runtime"/L"node.exe", entry=root/L"app"/L"tools"/L"installer"/L"runtime"/L"launch.mjs";
  if(!std::filesystem::is_regular_file(node) || !std::filesystem::is_regular_file(entry))return 2;
  const auto profile=environment(service?L"ProgramData":L"LOCALAPPDATA");
  if(profile.empty())return 2;
  auto logs=std::filesystem::path(profile)/L"MESHomework";
  std::error_code error;std::filesystem::create_directories(logs,error);if(error)return 2;
  SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES),nullptr,TRUE};
  HANDLE input=INVALID_HANDLE_VALUE,output=INVALID_HANDLE_VALUE;
  if(!CreatePipe(&input,&output,&security,0))return 2;
  SetHandleInformation(output,HANDLE_FLAG_INHERIT,0);
  HANDLE log=CreateFileW((logs/L"launcher.log").c_str(),GENERIC_WRITE,FILE_SHARE_READ|FILE_SHARE_WRITE,&security,OPEN_ALWAYS,FILE_ATTRIBUTE_NORMAL,nullptr);
  if(log==INVALID_HANDLE_VALUE){CloseHandle(input);CloseHandle(output);return 2;}
  LARGE_INTEGER size{};GetFileSizeEx(log,&size);
  if(size.QuadPart>1024*1024){SetFilePointer(log,0,nullptr,FILE_BEGIN);SetEndOfFile(log);}else SetFilePointer(log,0,nullptr,FILE_END);
  HANDLE job=CreateJobObjectW(nullptr,nullptr);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  MEMORYSTATUSEX memory{sizeof(MEMORYSTATUSEX)};
  if(GlobalMemoryStatusEx(&memory)){
    limits.JobMemoryLimit=static_cast<SIZE_T>(memory.ullTotalPhys/4*3);
    limits.BasicLimitInformation.LimitFlags|=JOB_OBJECT_LIMIT_JOB_MEMORY;
  }
  if(!job || !SetInformationJobObject(job,JobObjectExtendedLimitInformation,&limits,sizeof(limits))){
    if(job)CloseHandle(job);CloseHandle(log);CloseHandle(input);CloseHandle(output);return 2;
  }
  std::wstring command=quote(node.wstring())+L" "+quote(entry.wstring());
  if(service)command+=L" --service --headless";
  else for(const auto& argument:arguments)command+=L" "+quote(argument);
  STARTUPINFOW startup{};startup.cb=sizeof(startup);startup.dwFlags=STARTF_USESTDHANDLES;
  startup.hStdInput=input;startup.hStdOutput=log;startup.hStdError=log;
  PROCESS_INFORMATION process{};auto mutableCommand=std::vector<wchar_t>(command.begin(),command.end());mutableCommand.push_back(0);
  const BOOL created=CreateProcessW(node.c_str(),mutableCommand.data(),nullptr,nullptr,TRUE,CREATE_NO_WINDOW|CREATE_SUSPENDED,nullptr,root.c_str(),&startup,&process);
  CloseHandle(input);CloseHandle(log);
  if(!created){CloseHandle(output);CloseHandle(job);return 2;}
  if(!AssignProcessToJobObject(job,process.hProcess)){
    TerminateProcess(process.hProcess,2);CloseHandle(process.hProcess);CloseHandle(process.hThread);CloseHandle(output);CloseHandle(job);return 2;
  }
  if(service){serviceInput=output;report(SERVICE_RUNNING);}
  ResumeThread(process.hThread);CloseHandle(process.hThread);
  while(WaitForSingleObject(process.hProcess,1000)==WAIT_TIMEOUT){
    const auto stopped=stopAt.load();if(service && stopped && GetTickCount64()-stopped>20000){TerminateJobObject(job,1);break;}
  }
  DWORD code=1;GetExitCodeProcess(process.hProcess,&code);
  serviceInput=INVALID_HANDLE_VALUE;CloseHandle(output);CloseHandle(process.hProcess);CloseHandle(job);
  return static_cast<int>(code);
}
void WINAPI serviceMain(DWORD,LPWSTR*) {
  serviceHandle=RegisterServiceCtrlHandlerExW(serviceName,control,nullptr);if(!serviceHandle)return;
  report(SERVICE_START_PENDING);
  int code=run(true,{});if(code)ExitProcess(static_cast<UINT>(code));report(SERVICE_STOPPED);
}
}
int WINAPI wWinMain(HINSTANCE,HINSTANCE,PWSTR,int) {
  int count=0;LPWSTR* argv=CommandLineToArgvW(GetCommandLineW(),&count);if(!argv)return 2;
  std::vector<std::wstring> arguments;bool service=false,quiet=false,selfTest=false,invalid=false;
  for(int i=1;i<count;i++){
    const std::wstring arg=argv[i];
    if(arg==L"--service")service=true;
    else if(arg==L"--self-test")selfTest=true;
    else if(arg==L"--headless" || arg==L"--no-browser" || arg==L"--stop")arguments.push_back(arg);
    else invalid=true;
    if(arg==L"--headless" || arg==L"--stop")quiet=true;
  }
  LocalFree(argv);
  if(selfTest)return quote(L"a b")==L"\"a b\"" && quote(L"a\\")==L"\"a\\\\\"" && quote(L"a\"b")==L"\"a\\\"b\"" ? 0 : 1;
  if(invalid)return 2;
  if(service){SERVICE_TABLE_ENTRYW table[]={{const_cast<LPWSTR>(serviceName),serviceMain},{nullptr,nullptr}};return StartServiceCtrlDispatcherW(table)?0:2;}
  const int code=run(false,arguments);
  if(code && !quiet)MessageBoxW(nullptr,L"MES Homework could not start. See application.log / launcher.log in %LOCALAPPDATA%\\MESHomework.",L"MES Homework",MB_OK|MB_ICONERROR);
  return code;
}
