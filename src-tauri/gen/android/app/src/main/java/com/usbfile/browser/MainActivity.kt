package com.usbfile.browser

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject

class MainActivity : TauriActivity() {
  private val handler = Handler(Looper.getMainLooper())
  private var insetsJson = "{\"t\":0,\"b\":0,\"l\":0,\"r\":0}"
  private var bridgeAttached = false
  private var probing = false

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT),
      navigationBarStyle = SystemBarStyle.dark(android.graphics.Color.TRANSPARENT)
    )
    super.onCreate(savedInstanceState)
    ViewCompat.setOnApplyWindowInsetsListener(window.decorView) { _, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      insetsJson = JSONObject()
        .put("t", bars.top)
        .put("b", bars.bottom)
        .put("l", bars.left)
        .put("r", bars.right)
        .toString()
      pushInsets()
      insets
    }
    probeWebView()
  }

  override fun onDestroy() {
    handler.removeCallbacksAndMessages(null)
    super.onDestroy()
  }

  private fun probeWebView() {
    if (probing) return
    probing = true
    handler.postDelayed({
      probing = false
      if (!attachBridge()) probeWebView()
    }, 250)
  }

  private fun attachBridge(): Boolean {
    val wv = findWebView(window.decorView) ?: return false
    if (!bridgeAttached) {
      bridgeAttached = true
      wv.addJavascriptInterface(Bridge(), "__SAFE_AREA")
    }
    pushInsets()
    return true
  }

  private fun pushInsets() {
    val wv = findWebView(window.decorView) ?: return
    wv.evaluateJavascript(
      "window.__applySafeArea&&window.__applySafeArea($insetsJson)", null
    )
  }

  private fun findWebView(v: View?): WebView? {
    if (v == null) return null
    if (v is WebView) return v
    if (v is ViewGroup) {
      for (i in 0 until v.childCount) {
        findWebView(v.getChildAt(i))?.let { return it }
      }
    }
    return null
  }

  private inner class Bridge {
    @JavascriptInterface
    fun get(): String = insetsJson
  }
}
