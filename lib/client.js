/**
 * dsh-meeting — 浏览器端（DSH 网页 / 桌面版界面）。手写成 dsh 客户端模块格式（window.__ModuleLoader__），不需要打包工具。
 * 在左侧栏加一个「约会议」图标，点开后主区显示本机 dsh-meeting 节点的约会议页面（iframe）。
 * 节点和 DSH 界面在同一台电脑上，地址取当前页面的主机名 + 节点端口（默认 4500）。
 */
window.__ModuleLoader__.load({
  id: "@maximehu97/dsh-meeting",
  factory: (require) => {
    var module = { exports: {} };
    var React = require("react");
    var h = React.createElement;

    var NS = "dsh-meeting";
    var PANEL_ID = "dsh-meeting";
    var PORT_KEY = "dsh-meeting:port";
    var zh = { panel: "约会议", title: "九派 · 约会议", open: "在新窗口打开", reload: "刷新", offline: "连不上本机的 dsh-meeting 节点", hint: "确认 dsh-meeting 已启动（手机页端口默认 4500），或在右边改端口。", port: "端口" };
    var en = { panel: "Meetings", title: "Jiupai · Meetings", open: "Open in new window", reload: "Reload", offline: "Cannot reach the local dsh-meeting node", hint: "Make sure dsh-meeting is running (page port 4500 by default), or change the port on the right.", port: "Port" };

    function readPort() {
      try { return +localStorage.getItem(PORT_KEY) || 4500; } catch (e) { return 4500; }
    }
    function nodeUrl(port) {
      var host = location.hostname || "127.0.0.1";
      if (host.indexOf(":") >= 0) host = "[" + host + "]";
      return "http://" + host + ":" + port + "/";
    }

    // 侧栏图标：日历
    function MeetingIcon(props) {
      var s = props.size || 20;
      return h("svg", { width: s, height: s, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
        h("rect", { x: 3.5, y: 5, width: 17, height: 15.5, rx: 2.5 }),
        h("path", { d: "M3.5 9.5h17M8 3v4M16 3v4" }),
        h("circle", { cx: 9, cy: 14, r: 1.2, fill: "currentColor", stroke: "none" }),
        h("circle", { cx: 15, cy: 14, r: 1.2, fill: "currentColor", stroke: "none" }),
        h("path", { d: "M10.4 14h3.2" }));
    }

    // 主区页面：工具条 + iframe
    function MeetingPage(props) {
      var t = props.t || function (k) { return zh[k] || k; };
      var st = React.useState(readPort), port = st[0], setPort = st[1];
      var nt = React.useState(0), nonce = nt[0], setNonce = nt[1];
      var ok = React.useState(null), up = ok[0], setUp = ok[1];
      var url = nodeUrl(port);
      React.useEffect(function () {
        var alive = true;
        setUp(null);
        fetch(url + "api/state", { mode: "cors" }).then(function (r) { if (alive) setUp(r.ok); }).catch(function () { if (alive) setUp(false); });
        return function () { alive = false; };
      }, [url, nonce]);
      var bar = { display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", borderBottom: "1px solid var(--border-subtle, rgba(127,127,127,.2))", fontSize: 13 };
      var btn = { border: "1px solid var(--border-subtle, rgba(127,127,127,.3))", background: "transparent", color: "inherit", borderRadius: 7, padding: "3px 10px", cursor: "pointer", fontSize: 12 };
      return h("div", { style: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0, width: "100%" } },
        h("div", { style: bar },
          h(MeetingIcon, { size: 18 }),
          h("b", null, t("title")),
          h("span", { style: { opacity: 0.6, fontSize: 12 } }, url),
          h("span", { style: { flex: 1 } }),
          h("label", { style: { fontSize: 12, opacity: 0.8 } }, t("port"), " ",
            h("input", { type: "number", value: port, style: { width: 64, fontSize: 12, padding: "2px 4px", background: "transparent", color: "inherit", border: "1px solid rgba(127,127,127,.3)", borderRadius: 5 },
              onChange: function (e) { var v = +e.target.value || 4500; setPort(v); try { localStorage.setItem(PORT_KEY, String(v)); } catch (x) {} } })),
          h("button", { style: btn, onClick: function () { setNonce(nonce + 1); } }, t("reload")),
          h("button", { style: btn, onClick: function () { window.open(url, "_blank", "noopener"); } }, t("open"))),
        up === false
          ? h("div", { style: { padding: 32, textAlign: "center", opacity: 0.85 } }, h("p", null, "⚠ " + t("offline") + "：" + url), h("p", { style: { fontSize: 13, opacity: 0.7 } }, t("hint")))
          : h("iframe", { key: url + nonce, src: url, title: t("title"), style: { flex: 1, width: "100%", border: 0, minHeight: 0, background: "#071318" }, allow: "notifications" }));
    }

    var inject = ["slots", "locale"];
    function apply(ctx) {
      ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "dsh-meeting: dictionaries");
      var t = ctx.locale.bind(NS);
      ctx.slots.inject("main", function () {
        return ctx.slots.register({ name: "main", key: PANEL_ID, locale: NS }, MeetingPage);
      });
      ctx.slots.inject("sidebar.panellist", function () {
        return ctx.slots.register({ name: "sidebar.panellist", id: PANEL_ID, order: 30, locale: NS, label: function () { return t("panel"); } }, MeetingIcon);
      });
    }

    module.exports.inject = inject;
    module.exports.apply = apply;
    module.exports.name = "dsh-meeting";
    return module.exports;
  },
});
