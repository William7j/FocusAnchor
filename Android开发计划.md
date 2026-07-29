# 专注阅读 Android 版开发计划

## 项目现状速览

当前是 **Electron + React + TypeScript** 桌面应用，核心功能：
- 本地书库（EPUB/PDF/TXT/MD/DOCX）
- 微信读书辅助悬浮层
- 高亮批注
- 阅读进度存储（IndexedDB/Dexie）
- 导出笔记

与系统的所有交互走 `window.readerNative` 这个 Electron 桥接层。

---

## 技术选型：Capacitor

**不建议用 React Native 或 Flutter 全量重写**，选择 **Capacitor**（Ionic 出品）的理由：

- ✅ 现有 React + TypeScript 代码几乎原封不动运行在 Android WebView 里
- ✅ Capacitor 的 native bridge 模式和现在的 `window.readerNative` 几乎同构，替换成本最低
- ✅ Dexie.js / IndexedDB 在 Android WebView（Chromium 内核）里原生支持，数据层零改动
- ✅ 成熟的官方插件覆盖文件读写、文档选取、分享等所有所需能力

---

## 四个开发阶段

### 阶段一：基础搭建（约 1 周）

**目标**：把现有 Web 代码跑进 Android WebView

#### 任务清单

1. **初始化 Capacitor**
   ```bash
   npm install @capacitor/core @capacitor/cli @capacitor/android
   npx cap init "专注阅读" "com.focusreader.app"
   npx cap add android
   ```

2. **配置构建流程**
   - 修改 `capacitor.config.ts`，指向 Vite 的构建输出（`dist/`）
   - 在 `package.json` 添加脚本：
     ```json
     "build:android": "vite build && cap sync android",
     "run:android": "cap run android"
     ```

3. **抽象 native bridge 适配层**
   - 创建 `src/native/index.ts`，定义统一接口：
     ```typescript
     export interface NativeBridge {
       library: {
         importDocuments(): Promise<NativeImportResult | []>;
         exportNotes(payload: ExportPayload): Promise<{ saved: boolean }>;
         deleteDocument(payload: { assetId: string }): Promise<{ deleted: boolean }>;
       };
       weread: {
         open(bounds: NativeBounds): Promise<{ visible: boolean; hasSession: boolean }>;
         // ... 其他方法
       };
     }
     
     export function getNativeBridge(): NativeBridge {
       // 根据平台返回 Electron 或 Capacitor 实现
       if (window.readerNative) return new ElectronBridge();
       return new CapacitorBridge();
     }
     ```
   - 创建 `src/native/electron.ts` 和 `src/native/capacitor.ts` 分别实现

4. **验证基础功能**
   - 书库页渲染
   - 首选项读写
   - Dexie 数据库在 WebView 里的兼容性

**里程碑**：能在 Android 模拟器上启动应用，看到书库页。

---

### 阶段二：文件与数据操作（约 1.5 周）

**目标**：替换所有依赖 Electron 的文件系统操作

#### 插件依赖

```bash
npm install @capacitor/filesystem @capacitor/share
npm install @capacitor-community/file-picker
```

#### 功能映射

| 桌面端（Electron） | Android（Capacitor 插件） | 实现要点 |
|---|---|---|
| 系统文件选择框 | `@capacitor/filesystem` + `file-picker` | 使用 SAF（存储访问框架）|
| 文件写入应用沙盒 | `Filesystem.writeFile` | 写入 `Documents` 目录 |
| 文件读取 | `Filesystem.readFile` | 返回 base64 或 blob URL |
| 删除文档 | `Filesystem.deleteFile` | 同时清理数据库记录 |
| 导出笔记 | `@capacitor/share` | 系统分享菜单或写入 Downloads |

#### 关键实现

**文档导入流程**：
```typescript
// src/native/capacitor.ts
async importDocuments() {
  // 1. 请求权限（Android 13+ 需要特定文件类型权限）
  const permissions = await Filesystem.requestPermissions();
  
  // 2. 打开文件选择器
  const result = await FilePicker.pickFiles({
    types: ['application/epub+zip', 'application/pdf', 'text/*'],
    multiple: true,
  });
  
  // 3. 复制文件到应用沙盒
  const imported: ImportedAsset[] = [];
  for (const file of result.files) {
    const checksum = await this.calculateChecksum(file.data);
    const assetId = crypto.randomUUID();
    await Filesystem.writeFile({
      path: `documents/${assetId}`,
      data: file.data,
      directory: Directory.Data,
    });
    imported.push({ assetId, checksum, /* ... */ });
  }
  
  return { imported, failures: [] };
}
```

**笔记导出**：
```typescript
async exportNotes({ content, format, suggestedName }) {
  const fileName = `${suggestedName}.${format}`;
  await Share.share({
    title: '导出笔记',
    text: format === 'markdown' ? content : undefined,
    files: format === 'json' ? [await this.saveTemp(content, fileName)] : undefined,
  });
  return { saved: true };
}
```

#### 注意事项

- Android 13+ 需要在 `AndroidManifest.xml` 声明权限：
  ```xml
  <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />
  <uses-permission android:name="android.permission.READ_MEDIA_DOCUMENTS" />
  ```
- 使用 SAF URI 避免直接访问外部存储
- 实现文件校验和计算（用 Web Crypto API）

**里程碑**：能在真机上导入一本 EPUB，打开阅读，退出后阅读进度保留。

---

### 阶段三：阅读器适配（约 2 周）

**目标**：三种阅读器在移动端的触摸交互和性能优化

#### 3.1 FlowReader（TXT/MD/DOCX）适配

**触摸交互**：
- 长按选文替代鼠标拖选
- 处理 `touchstart`/`touchend` 和 `selection` API 的差异
- 优化选中文本后的上下文菜单（Android 原生选择菜单）

**实现要点**：
```typescript
// src/lib/selection.ts 增加触摸支持
function setupTouchSelection(element: HTMLElement) {
  let pressTimer: number;
  
  element.addEventListener('touchstart', (e) => {
    pressTimer = window.setTimeout(() => {
      // 长按 500ms 触发选择模式
      enableSelectionMode();
    }, 500);
  });
  
  element.addEventListener('touchend', () => {
    clearTimeout(pressTimer);
  });
}
```

**无需改动**：
- 句子高亮逻辑
- 段落聚焦逻辑
- Mark.js 标注渲染

#### 3.2 EpubReader 适配

**epub.js 触摸支持**：
```typescript
// src/reader/EpubReader.tsx
rendition.on('touchstart', handleTouchStart);
rendition.on('touchend', handleTouchEnd);

function handleSwipe(direction: 'left' | 'right') {
  if (direction === 'left') rendition.next();
  else rendition.prev();
}
```

**已知问题修复**：
- Chromium WebView 里 epub.js 的字体渲染问题（在 CSS 里强制 `-webkit-font-smoothing: antialiased`）
- iframe 内容跨域策略（需要在 Capacitor 配置里允许 `file://` 协议）

#### 3.3 PdfReader 适配

**性能优化**（最关键）：
```typescript
// src/reader/PdfReader.tsx
import * as pdfjsLib from 'pdfjs-dist';

// 1. 启用 Web Worker（避免主线程阻塞）
pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.js';

// 2. 虚拟化渲染（仅渲染可见页+前后各1页）
const visiblePages = useMemo(() => {
  const current = currentPage;
  return [current - 1, current, current + 1].filter(p => p >= 1 && p <= numPages);
}, [currentPage, numPages]);

// 3. 降低渲染分辨率（移动端）
const scale = isMobile ? 1.5 : 2.0;
```

**触摸手势**：
- 双指缩放（pinch-to-zoom）
- 左右滑动翻页
- 双击缩放到 100% / 150% 切换

**实现示例**：
```typescript
function usePinchZoom(canvasRef: RefObject<HTMLCanvasElement>) {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    let initialDistance = 0;
    let initialScale = 1;
    
    const handleTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      e.preventDefault();
      
      const distance = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      
      if (initialDistance === 0) {
        initialDistance = distance;
        initialScale = currentScale;
      }
      
      const newScale = initialScale * (distance / initialDistance);
      setScale(clamp(newScale, 0.5, 3.0));
    };
    
    canvas.addEventListener('touchmove', handleTouchMove, { passive: false });
    return () => canvas.removeEventListener('touchmove', handleTouchMove);
  }, [currentScale]);
}
```

#### 3.4 通用 UI 适配

**响应式布局**：
```css
/* src/style.css 增加移动端样式 */
@media (max-width: 768px) {
  .app-shell {
    flex-direction: column;
  }
  
  /* 侧边栏改成底部导航 */
  .app-sidebar {
    flex-direction: row;
    width: 100%;
    height: 60px;
    order: 2;
  }
  
  .app-main {
    order: 1;
  }
  
  /* 阅读器工具栏折叠 */
  .reader-toolbar {
    position: fixed;
    bottom: 60px;
    transform: translateY(100%);
    transition: transform 0.3s;
  }
  
  .reader-toolbar.is-visible {
    transform: translateY(0);
  }
}
```

**触摸友好控件**：
- 字号/行高滑块最小触摸目标 44x44px
- 按钮间距至少 8px
- 支持滑动关闭模态框

**里程碑**：三种格式均可在真机上流畅阅读，触摸选文和高亮批注功能正常。

---

### 阶段四：微信读书适配与收尾（约 1 周）

#### 4.1 微信读书模块

**架构差异**：桌面端用 Electron 的 `BrowserView` 内嵌了整个微信读书网页，Android 上无法直接复用。

**方案 A（推荐）**：应用内 WebView 加载
```typescript
// src/native/capacitor.ts
async openWeread(bounds: NativeBounds) {
  // 使用 Capacitor 插件打开内嵌 WebView
  await Browser.open({
    url: 'https://weread.qq.com',
    presentationStyle: 'popover',
    toolbarColor: '#f5f5f5',
  });
  
  // 辅助功能（焦点遮罩、句子高亮）通过注入 JavaScript 实现
  await Browser.executeScript({
    code: wereadAssistScript,
  });
  
  return { visible: true, hasSession: await this.checkWereadSession() };
}
```

**需要处理**：
- WebView 安全策略（CSP）
- Cookie 跨域共享（用 `@capacitor/cookies` 插件）
- 注入脚本的生命周期管理

**方案 B（保守）**：Intent 调用微信读书 App
```typescript
async openWeread() {
  try {
    await AppLauncher.openUrl({ url: 'weread://open' });
    return { visible: false, hasSession: false };
  } catch {
    // 未安装微信读书 App，打开应用商店
    await Browser.open({ url: 'market://details?id=com.tencent.weread' });
  }
}
```

在应用内提示："请在微信读书 App 中阅读，回来后可导入笔记"。

**推荐实施顺序**：
1. 先用方案 B 让功能降级可用
2. 再逐步实现方案 A 的完整体验

#### 4.2 收尾工作

**应用资源**：
```bash
# 生成各尺寸图标和启动屏
npm install @capacitor/assets --save-dev
npx capacitor-assets generate --iconBackgroundColor '#ffffff'
```

**权限申请**：
```xml
<!-- android/app/src/main/AndroidManifest.xml -->
<uses-permission android:name="android.permission.READ_MEDIA_DOCUMENTS" />
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
```

**打包配置**：
```json
// package.json
{
  "scripts": {
    "build:windows": "electron-builder --win",
    "build:android": "vite build && cap sync android && cd android && ./gradlew assembleRelease",
    "release": "npm run build:windows && npm run build:android"
  }
}
```

**测试矩阵**：
| 设备 | 屏幕尺寸 | Android 版本 | 测试重点 |
|---|---|---|---|
| Pixel 6 模拟器 | 6.4" | Android 13 | 文件权限、Share API |
| 小米 12 真机 | 6.28" | Android 12 | MIUI 适配、PDF 性能 |
| 三星 Galaxy Tab | 10.5" | Android 11 | 平板布局、横屏 |
| 老旧测试机 | 5.5" | Android 9 | 最低兼容性、低端性能 |

**里程碑**：输出签名的 `.apk` / `.aab`，全功能验收通过。

---

## 关键依赖

```json
{
  "dependencies": {
    "@capacitor/core": "^6.0.0",
    "@capacitor/android": "^6.0.0",
    "@capacitor/filesystem": "^6.0.0",
    "@capacitor/share": "^6.0.0",
    "@capacitor/browser": "^6.0.0",
    "@capacitor/app-launcher": "^6.0.0",
    "@capacitor-community/file-picker": "^6.0.0"
  },
  "devDependencies": {
    "@capacitor/cli": "^6.0.0",
    "@capacitor/assets": "^3.0.0"
  }
}
```

---

## 工作量估算

| 阶段 | 任务 | 预计工作量 |
|---|---|---|
| **阶段一** | 基础搭建 | 3 天 |
| **阶段二** | 文件与数据操作 | 5 天 |
| **阶段三** | FlowReader 适配 | 2 天 |
|  | EpubReader 适配 | 2 天 |
|  | PdfReader 适配 | 4 天 |
| **阶段四** | 微信读书适配 | 2 天 |
|  | 收尾与测试 | 2 天 |
| **合计** |  | **约 20 个工作日（4 周）** |

---

## 风险点与应对

### 高风险

1. **PDF.js 在低端机型的性能**
   - **验证时机**：阶段二结束时
   - **应对方案**：虚拟化渲染 + 降低分辨率 + 考虑使用原生 PDF 渲染器（如 `android.graphics.pdf.PdfRenderer`）

2. **微信读书 WebView Cookie/会话兼容性**
   - **验证时机**：阶段三开始前
   - **应对方案**：优先实现方案 B（Intent 调用），方案 A 作为迭代目标

### 中风险

3. **触摸选文的体验差异**
   - **应对方案**：参考 Google Play Books 的交互模式，提供"选择模式"开关

4. **不同 Android 厂商的 WebView 差异**（MIUI/EMUI/OneUI）
   - **应对方案**：在多品牌真机上回归测试，建立兼容性文档

---

## 下一步行动

运行以下命令开始阶段一：

```bash
# 1. 安装 Capacitor
npm install @capacitor/core @capacitor/cli @capacitor/android

# 2. 初始化
npx cap init "专注阅读" "com.focusreader.app"

# 3. 添加 Android 平台
npx cap add android

# 4. 同步代码到 Android 项目
npm run build
npx cap sync android

# 5. 在 Android Studio 中打开项目
npx cap open android
```

---

## 附录：目录结构变化

```
ADHD阅读辅助/
├── android/                    # 新增：Android 原生项目
│   ├── app/
│   │   └── src/main/
│   │       ├── AndroidManifest.xml
│   │       └── java/com/focusreader/app/
│   └── build.gradle
├── src/
│   ├── native/                 # 新增：平台适配层
│   │   ├── index.ts           # 统一接口
│   │   ├── electron.ts        # Electron 实现
│   │   └── capacitor.ts       # Capacitor 实现
│   ├── components/
│   ├── reader/
│   └── ...
├── capacitor.config.ts         # 新增：Capacitor 配置
└── package.json
```
