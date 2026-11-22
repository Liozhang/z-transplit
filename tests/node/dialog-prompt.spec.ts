/**
 * dialog — 模态提示框的调用形状。
 *
 * 为什么单测它：`promptDialog` 在真机上曾经完全失效而单元测试全绿。原因是
 * nsIPromptService.prompt 的输入值与复选框状态都是 `inout` 参数，XPConnect 对
 * `inout` 参数只收对象（`{ value: … }`），原始值或 null 一律
 * NS_ERROR_XPC_NEED_OUT_OBJECT。产品给复选框状态传了 null，于是"翻译指定页"每
 * 次调用都在弹出对话框之前抛错，被 try/catch 吞掉返回 null，菜单项看起来点了没
 * 反应。Node 里没有 XPConnect，只有把这条规矩写成一个假服务，回归才拦得住。
 *
 * 这里只钉形状与 never-throws 契约，不弹真对话框。
 *
 * @module tests/node/dialog-prompt
 */

import { afterEach, describe, expect, it } from "vitest";

import { alertDialog, promptDialog } from "../../src/utils/dialog";

/** 照 XPConnect 的规矩做的假 nsIPromptService：`inout` 参数只收对象。 */
function makeFakePromptService() {
  const calls: any[] = [];
  let answer = true;
  return {
    calls,
    answerWith: (value: boolean) => {
      answer = value;
    },
    service: {
      prompt(
        parent: any,
        title: any,
        text: any,
        value: any,
        checkMsg: any,
        checkState: any,
      ) {
        // 快照而不是存引用：答完要往 value 里写，存引用会让断言看到写后的值。
        calls.push({
          parent,
          title,
          text,
          value: { value: value && typeof value === "object" ? value.value : value },
          checkMsg,
          checkState,
        });
        // 位置 4：输入值，inout，必须是对象。
        if (!value || typeof value !== "object") {
          throw new Error(
            "'Out' argument must be an object arg 3 [nsIPromptService.prompt]",
          );
        }
        // 位置 5：复选框说明文字，in wstring，null 合法。
        // 位置 6：复选框状态，inout，必须是对象——就是产品原先漏掉的那个。
        if (checkState !== null && (!checkState || typeof checkState !== "object")) {
          throw new Error(
            "'Out' argument must be an object arg 5 [nsIPromptService.prompt]",
          );
        }
        if (!answer) return false;
        value.value = "1-2";
        return true;
      },
      alert(parent: any, title: any, text: any) {
        calls.push({ alert: { parent, title, text } });
      },
    },
  };
}

describe("promptDialog", () => {
  const original = (globalThis as any).Services;
  const originalZotero = (globalThis as any).Zotero;

  afterEach(() => {
    (globalThis as any).Services = original;
    (globalThis as any).Zotero = originalZotero;
  });

  it("复选框状态按 inout 参数传对象，输入值也传对象", () => {
    const fake = makeFakePromptService();
    (globalThis as any).Services = { prompt: fake.service };

    const got = promptDialog("标题", "请输入页码范围", "", { id: "win" });

    expect(got).toBe("1-2");
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    expect(call.parent).toEqual({ id: "win" });
    expect(call.title).toBe("标题");
    expect(call.text).toBe("请输入页码范围");
    // 两个 inout 参数都必须是对象，null 会让真机上的调用直接抛错。
    expect(call.value).toEqual({ value: "" });
    expect(call.checkMsg).toBeNull();
    expect(call.checkState).toEqual({ value: false });
  });

  it("用户取消时返回 null，不把假回答当输入", () => {
    const fake = makeFakePromptService();
    fake.answerWith(false);
    (globalThis as any).Services = { prompt: fake.service };

    expect(promptDialog("标题", "说明")).toBeNull();
  });

  it("提示服务抛错时返回 null，不把异常抛给调用方", () => {
    const calls: any[] = [];
    (globalThis as any).Services = {
      prompt: {
        prompt: (...args: any[]) => {
          calls.push(args);
          throw new Error(
            "'Out' argument must be an object arg 5 [nsIPromptService.prompt]",
          );
        },
      },
    };

    // never-throws 契约：对话框失败不能把调用方带走。真机上这条曾经反过来——
    // 调用方活得好好的，只是功能静默失效。
    expect(() => promptDialog("标题", "说明")).not.toThrow();
    expect(promptDialog("标题", "说明")).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("没有提示服务时返回 null，不抛错", () => {
    (globalThis as any).Services = {};
    expect(promptDialog("标题", "说明")).toBeNull();
    delete (globalThis as any).Services;
    expect(promptDialog("标题", "说明")).toBeNull();
  });

  it("没传窗口时回退到 Zotero.getMainWindow()", () => {
    const fake = makeFakePromptService();
    (globalThis as any).Services = { prompt: fake.service };
    (globalThis as any).Zotero = { getMainWindow: () => ({ id: "main" }) };

    promptDialog("标题", "说明");

    expect(fake.calls[0].parent).toEqual({ id: "main" });
  });

  it("初始值被转成字符串后放进输入对象", () => {
    const fake = makeFakePromptService();
    (globalThis as any).Services = { prompt: fake.service };

    promptDialog("标题", "说明", 0 as any, { id: "win" });

    expect(fake.calls[0].value).toEqual({ value: "0" });
  });
});

describe("alertDialog", () => {
  const original = (globalThis as any).Services;

  afterEach(() => {
    (globalThis as any).Services = original;
  });

  it("带上父窗口调用 alert，标题与正文顺序不变", () => {
    const fake = makeFakePromptService();
    (globalThis as any).Services = { prompt: fake.service };

    alertDialog("标题", "正文", { id: "win" });

    expect(fake.calls[0].alert).toEqual({
      parent: { id: "win" },
      title: "标题",
      text: "正文",
    });
  });

  it("alert 失败不抛出", () => {
    (globalThis as any).Services = {
      prompt: {
        alert: () => {
          throw new Error("no window");
        },
      },
    };

    expect(() => alertDialog("标题", "正文")).not.toThrow();
  });
});
