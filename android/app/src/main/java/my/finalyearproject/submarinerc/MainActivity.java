package my.finalyearproject.submarinerc;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

public class MainActivity extends Activity {
    private static final String HOME_URL = "https://appassets.androidplatform.net/controller/index.html";
    private static final String ASSET_HOST = "appassets.androidplatform.net";
    private static final String ASSET_PREFIX = "/controller/";
    private static final String ALLOWED_HOST = "192.168.4.1";
    private WebView webView;
    private ValueCallback<Uri[]> fileChooserCallback;
    private static final int FILE_CHOOSER_REQUEST = 41;

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.rgb(8, 16, 24));
        showController();
    }

    @SuppressWarnings("SetJavaScriptEnabled")
    private void showController() {
        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setMediaPlaybackRequiresUserGesture(false);
        webView.setBackgroundColor(Color.rgb(8, 16, 24));
        webView.addJavascriptInterface(new AndroidBridge(), "SubmarineAndroid");
        webView.setWebViewClient(new RestrictedClient());
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileChooserCallback != null) fileChooserCallback.onReceiveValue(null);
                fileChooserCallback = callback;
                try { startActivityForResult(params.createIntent(), FILE_CHOOSER_REQUEST); }
                catch (ActivityNotFoundException error) { fileChooserCallback = null; Toast.makeText(MainActivity.this, "No file picker is available", Toast.LENGTH_LONG).show(); return false; }
                return true;
            }

            @Override public void onPermissionRequest(PermissionRequest request) {
                request.deny(); // The controller does not need Android camera, microphone, or location access.
            }
        });
        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, length) -> {
            if (isAllowed(Uri.parse(url))) Toast.makeText(this, "Use the page capture/export buttons to save this file", Toast.LENGTH_LONG).show();
        });
        setContentView(webView);
        webView.loadUrl(HOME_URL);
    }

    private boolean isAllowed(Uri uri) {
        return "http".equalsIgnoreCase(uri.getScheme()) && ALLOWED_HOST.equals(uri.getHost()) && (uri.getPort() == -1 || uri.getPort() == 80 || uri.getPort() == 81);
    }

    private boolean isBundledController(Uri uri) {
        return "https".equalsIgnoreCase(uri.getScheme()) && ASSET_HOST.equals(uri.getHost()) && uri.getPath() != null && uri.getPath().startsWith(ASSET_PREFIX);
    }

    private String assetMimeType(String path) {
        if (path.endsWith(".html")) return "text/html";
        if (path.endsWith(".js")) return "text/javascript";
        if (path.endsWith(".css")) return "text/css";
        if (path.endsWith(".json") || path.endsWith(".map")) return "application/json";
        return "application/octet-stream";
    }

    private final class RestrictedClient extends WebViewClient {
        @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (!isBundledController(uri)) return super.shouldInterceptRequest(view, request);
            String path = uri.getPath();
            if (path == null || path.contains("..")) return null;
            try {
                InputStream input = getAssets().open(path.substring(1));
                return new WebResourceResponse(assetMimeType(path), "UTF-8", input);
            } catch (IOException error) {
                return null;
            }
        }

        @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (isAllowed(uri) || isBundledController(uri)) return false;
            if ("https".equalsIgnoreCase(uri.getScheme())) {
                try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); } catch (ActivityNotFoundException ignored) { }
            }
            Toast.makeText(MainActivity.this, "Navigation outside the submarine controller is blocked", Toast.LENGTH_SHORT).show();
            return true;
        }

        @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) Toast.makeText(MainActivity.this, "Controller UI could not be loaded", Toast.LENGTH_LONG).show();
        }
    }

    @Override public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack(); else super.onBackPressed();
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_CHOOSER_REQUEST && fileChooserCallback != null) {
            fileChooserCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileChooserCallback = null;
        }
    }

    public final class AndroidBridge {
        @JavascriptInterface public void openWifiSettings() {
            runOnUiThread(() -> startActivity(new Intent(Settings.ACTION_WIFI_SETTINGS)));
        }

        @JavascriptInterface public void saveBase64(String requestedName, String mimeType, String base64Data) {
            runOnUiThread(() -> {
                try {
                    String fileName = requestedName == null ? "submarine-file" : requestedName.replaceAll("[^a-zA-Z0-9._-]", "_");
                    byte[] bytes = Base64.decode(base64Data, Base64.DEFAULT);
                    OutputStream output;
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        ContentValues values = new ContentValues();
                        values.put(MediaStore.Downloads.DISPLAY_NAME, fileName);
                        values.put(MediaStore.Downloads.MIME_TYPE, mimeType);
                        values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/SubmarineRC");
                        Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                        if (uri == null) throw new IllegalStateException("Cannot create download");
                        output = getContentResolver().openOutputStream(uri);
                    } else {
                        File directory = new File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "SubmarineRC");
                        if (!directory.exists() && !directory.mkdirs()) throw new IllegalStateException("Cannot create download directory");
                        output = new FileOutputStream(new File(directory, fileName));
                    }
                    if (output == null) throw new IllegalStateException("Cannot open download");
                    output.write(bytes);
                    output.close();
                    Toast.makeText(MainActivity.this, "Saved to Downloads/SubmarineRC", Toast.LENGTH_LONG).show();
                } catch (Exception error) {
                    Toast.makeText(MainActivity.this, "Save failed: " + error.getMessage(), Toast.LENGTH_LONG).show();
                }
            });
        }
    }
}
