(function () {
  function removeOldToasts() {
    document.querySelectorAll(".__kabegame_surf_toast__").forEach((el) => el.remove());
  }

  window.__kabegame_toast = function (message, type) {
    try {
      removeOldToasts();
      var toast = document.createElement("div");
      toast.className = "__kabegame_surf_toast__";
      toast.textContent = String(message || "");
      toast.style.position = "fixed";
      toast.style.top = "20px";
      toast.style.left = "50%";
      toast.style.transform = "translateX(-50%)";
      toast.style.maxWidth = "80vw";
      toast.style.padding = "10px 14px";
      toast.style.borderRadius = "8px";
      toast.style.color = "#fff";
      toast.style.fontSize = "13px";
      toast.style.fontWeight = "600";
      toast.style.boxShadow = "0 8px 24px rgba(0,0,0,.2)";
      toast.style.zIndex = "2147483647";
      toast.style.opacity = "0";
      toast.style.transition = "opacity .2s ease";
      if (type === "success") toast.style.background = "#16a34a";
      else if (type === "start") toast.style.background = "#2563eb";
      else toast.style.background = "#dc2626";

      document.body.appendChild(toast);
      requestAnimationFrame(function () {
        toast.style.opacity = "1";
      });

      setTimeout(function () {
        toast.style.opacity = "0";
        setTimeout(function () {
          if (toast.parentNode) toast.parentNode.removeChild(toast);
        }, 220);
      }, 2200);
    } catch (_) {
      // ignore toast rendering errors
    }
  };
})();
