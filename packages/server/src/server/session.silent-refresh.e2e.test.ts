// 【joy】-用隔离 daemon 和原生 WebSocket 验证静默重载；provider 使用可控假客户端，不接触团队会话。
import { test, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDaemonTestContext } from "./test-utils/daemon-test-context.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";

test("silent refresh keeps the original timeline and persistence without replaying output", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "silent-refresh-"));
  const ctx = await createDaemonTestContext();
  try {
    const agent = await ctx.client.createAgent({
      config: { provider: "claude", cwd, modeId: "full-access" },
    });
    const manager = ctx.daemon.daemon.agentManager;
    await manager.appendTimelineItem(agent.id, { type: "assistant_message", text: "old answer" });
    await manager.flush();
    const before = await ctx.client.fetchAgentTimeline(agent.id, { limit: 100 });
    const frames: unknown[] = [];
    const unsubscribe = ctx.client.subscribe((event) => {
      if (event.type === "agent_stream" && event.agentId === agent.id) frames.push(event);
    });
    const subscription = ctx.client.subscribeAgentTimeline(agent.id, () => {});
    // 【joy】-订阅就绪后再刷新，确保旧输出不会因缺少观察者而漏检。
    await ctx.client.fetchAgents({ subscribe: {} });
    const managerFrames: unknown[] = [];
    const stop = manager.subscribe((event) => {
      if (event.type === "agent_stream" && event.agentId === agent.id) managerFrames.push(event);
    });
    await ctx.client.refreshAgentSilently(agent.id);
    await ctx.client.refreshAgentSilently(agent.id);
    const after = await ctx.client.fetchAgent(agent.id);
    const timeline = await ctx.client.fetchAgentTimeline(agent.id, { limit: 100 });
    expect(after.agent?.id).toBe(agent.id);
    expect(after.agent?.persistence).toEqual(agent.persistence);
    expect(timeline.entries).toEqual(before.entries);
    expect(frames).toEqual([]);
    expect(managerFrames).toEqual([]);
    await ctx.client.sendMessage(agent.id, "Say hello");
    await ctx.client.waitForFinish(agent.id, 15000);
    expect(frames.length).toBeGreaterThan(0);
    unsubscribe();
    subscription();
    stop();
  } finally {
    await ctx.cleanup();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("silent refresh refuses a running turn instead of cancelling it", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "silent-refresh-busy-"));
  let finish!: () => void;
  const hold = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const ctx = await createDaemonTestContext({
    agentClients: createTestAgentClients({
      onStartTurn: () => started(),
      beforeTurnComplete: () => hold,
    }),
  });
  try {
    const agent = await ctx.client.createAgent({
      config: { provider: "claude", cwd, modeId: "full-access" },
    });
    await ctx.client.sendMessage(agent.id, "Continue work");
    await running;
    await expect(ctx.client.refreshAgentSilently(agent.id)).rejects.toThrow("busy");
    expect(ctx.daemon.daemon.agentManager.hasInFlightRun(agent.id)).toBe(true);
    finish();
    await ctx.client.waitForFinish(agent.id, 15000);
    await ctx.client.refreshAgentSilently(agent.id);
  } finally {
    finish();
    await ctx.cleanup();
    await rm(cwd, { recursive: true, force: true });
  }
});

// 【joy】-待审批保持原请求，静默维护不能代审批、取消或重新生成权限请求。
test("silent refresh preserves pending permission requests", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "silent-refresh-permission-"));
  const ctx = await createDaemonTestContext();
  try {
    const agent = await ctx.client.createAgent({
      config: { provider: "codex", cwd, modeId: "default" },
    });
    await ctx.client.sendMessage(agent.id, 'Use the shell tool: printf "ok" > permission.txt');
    const waiting = await ctx.client.waitForFinish(agent.id, 15000);
    expect(waiting.status).toBe("permission");
    const before = ctx.daemon.daemon.agentManager.getPendingPermissions(agent.id);
    expect(before.length).toBeGreaterThan(0);
    await expect(ctx.client.refreshAgentSilently(agent.id)).rejects.toThrow("busy");
    expect(ctx.daemon.daemon.agentManager.getPendingPermissions(agent.id)).toEqual(before);
    await ctx.client.respondToPermission(agent.id, before[0]!.id, { behavior: "allow" });
    await ctx.client.waitForFinish(agent.id, 15000);
  } finally {
    await ctx.cleanup();
    await rm(cwd, { recursive: true, force: true });
  }
});
test("silent refresh does not reopen a closed agent", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "silent-refresh-closed-"));
  const ctx = await createDaemonTestContext();
  try {
    const agent = await ctx.client.createAgent({
      config: { provider: "claude", cwd, modeId: "full-access" },
    });
    await ctx.daemon.daemon.agentManager.closeAgent(agent.id);
    await expect(ctx.client.refreshAgentSilently(agent.id)).rejects.toThrow();
    expect(ctx.daemon.daemon.agentManager.getAgent(agent.id)?.lifecycle).not.toBe("idle");
  } finally {
    await ctx.cleanup();
    await rm(cwd, { recursive: true, force: true });
  }
});
