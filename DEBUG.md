# 本机后端调试

调试功能需显式启动，仅监听 `127.0.0.1`。普通离线页面、静态部署和玩家界面均不加载调试桥，也没有调试按钮或快捷键。需要 Node.js 18 或更新版本，无第三方依赖。

```powershell
node debug-server.cjs
# 或选择端口；--port=0 由系统分配
node debug-server.cjs --port=8787
```

终端输出 JSON，包含 `url` 和本次进程的 `token`。用浏览器打开该 URL 并保持页面打开。后端通过 HTTP 请求把命令交给此页面，由真实游戏函数渲染、结算和保存。没有连接的浏览器时不会假装执行成功。关闭终端或 Ctrl+C 停止服务。

调试页面使用 `afo-debug-save-3.0.0`，普通玩家仍使用原来的存档键；不清除、不覆盖普通玩家存档。调试状态允许与正常路线不一致，不能用于证明自然触发条件，也不应导入玩家存档。

## 从后端发命令

下例使用服务器刚输出的地址和 token：

```powershell
$debugUrl = 'http://127.0.0.1:8787'
$debugHeaders = @{ Authorization = 'Bearer <本次终端输出的token>' }
Invoke-RestMethod "$debugUrl/__debug__/sessions" -Headers $debugHeaders

$debugRequest = @{
    command = @{
        op = 'enter'
        scene = 'S18'
        week = 22
        seed = 17
        state = @{
            energy = 45
            subjects = @{ math = 35.25; chinese = 57.7 }
            examHistory = @(@{ week = 9; score = 27 })
        }
    }
} | ConvertTo-Json -Depth 30
$debugJob = Invoke-RestMethod "$debugUrl/__debug__/command" -Method Post -Headers $debugHeaders -ContentType 'application/json' -Body $debugRequest
Invoke-RestMethod "$debugUrl/__debug__/jobs/$($debugJob.jobId)" -Headers $debugHeaders
```

命令提交返回 `jobId`；轮询结果直到 `status` 为 `done` 或 `error`。多个浏览器页面同时连接时，请在请求顶层另填 `sessionId`，明确目标页面。任务30秒未完成会报告超时；结果保留5分钟。浏览器暂时休眠/后台限速可能影响等待时间。

## 命令

| `command.op` | 参数与作用 |
| --- | --- |
| `catalog` | 返回全部主线、支线、回忆、随机事件、结局及ID、选项、作者排期与状态字段，供调试定位。 |
| `load` | 从初始状态装载夹具。`week`为1—52，`state`为状态字段补丁，`seed`为可复现的32位无符号随机种子，默认1。自动设置该周倒计时、季节、已结束周数和课程表，可在`state`中覆盖派生字段。不会凭空补完前面各周。 |
| `patch` | 用`state`修改当前调试状态，未填写字段保留。用于在同一前置经历下改变数值。 |
| `enter` | `scene`指定ID，`week`可指定任意周，`state`指定数值和经历。默认先`load`；`reset:false`保留当前经历。强制进入绕过发现/排期条件，选项、效果、主线自动分支仍由真实函数处理。主线打开时即按原机制结算，请用结果中的状态/日志确认，不重复人工结算。 |
| `respond` | 当前场景可填`key:'A'`及必要的`targets:['math']`；或`index:0`点击当前剧情窗口中对应按钮。 |
| `act` | `action`为`study`、`rest`、`social`、`exam`、`homework`、`continue`、`endWeek`、`exercise`或`bluebook`。必要时填`value`，如`sleep`、`math`、`complete-all`。正常行动限制仍生效。 |
| `snapshot` | 返回完整状态、随机状态、存档键、游戏日志、当前可见窗口文字和主面板文字。可将JSON保存到本地作为复现夹具。 |
| `restore` | 用`snapshot`装回先前导出的状态及随机状态，恢复尚未读完的窗口。 |
| `route` | 在考后用`route:'C01'`等打开方向；`field`/`value`设置准备项，`confirm:true`经正常条件确认。 |

`enter.scene`也可填 `@home`、`@homework`、`@bluebook`、`@rest`、`@exam`、`@postExam`。结局ID使用真实模板预览，结果标记为 `ending-preview`，不代表通过正常路线获得这个结局。要核查完整路线结算，应准备真实经历并经`route`确认。

`state`支持六科学科、八位人物、核心属性、余额、行动/模考/作业记录、前置场景选择、小目标等现有字段。对象递归合并，数组整体替换；`achievements`用字符串数组表示。数值接受任意有限数字，可填小数、负数、超过100的边界值，装载时不静默截断；执行实际行动后，游戏原有约束照常生效。周数和行动计数须满足结构约束。未知字段、错误类型、非有限数字、保留对象键及过深对象报错。

例如复查原任务与当前最弱科不同：

```json
{
  "command": {
    "op": "enter",
    "scene": "S22",
    "week": 28,
    "state": {
      "subjects": { "chinese": 57.7, "math": 61.1, "english": 65, "physics": 70, "chemistry": 66, "biology": 63.3 },
      "practiceGoal": { "week": 22, "subjects": ["math"] },
      "actionHistory": [{ "week": 23, "kind": "study", "detail": "math" }]
    }
  }
}
```

多数变更命令结果包含`state`、`visible`、`log`、`delta`和`debugLog`。截图由浏览器截图工具在命令完成后保存；HTTP JSON本身不伪造截图。固定种子只控制此调试页面内的随机过程，普通玩家随机行为不变。

仅将本服务用于本机调试。服务有随机Bearer令牌、同源校验、文件白名单和请求大小限制，不提供远程公网调试服务，不执行任意脚本或shell命令。
