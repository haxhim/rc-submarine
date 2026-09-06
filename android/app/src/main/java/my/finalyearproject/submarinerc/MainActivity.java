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
import android.view.Gravity;
import android.view.View;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

public class MainActivity extends Activity {
    private static final String HOME_URL = "http://192.168.4.1/";
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
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
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

    private final class RestrictedClient extends WebViewClient {
        @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (isAllowed(uri)) return false;
            if ("https".equalsIgnoreCase(uri.getScheme())) {
                try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); } catch (ActivityNotFoundException ignored) { }
            }
            Toast.makeText(MainActivity.this, "Navigation outside the submarine controller is blocked", Toast.LENGTH_SHORT).show();
            return true;
        }

        @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) showOffline();
        }
    }

    private void showOffline() {
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setGravity(Gravity.CENTER);
        panel.setPadding(52, 52, 52, 52);
        panel.setBackgroundColor(Color.rgb(8, 16, 24));

        TextView title = new TextView(this);
        title.setText("Submarine controller offline");
        title.setTextColor(Color.WHITE);
        title.setTextSize(24);
        title.setGravity(Gravity.CENTER);

        TextView help = new TextView(this);
        help.setText("1. Power the ESP32-CAM\n2. Join Wi-Fi SUB-RC-<device-id>\n3. Use password NautilusRC!\n4. Return here and tap Retry");
        help.setTextColor(Color.rgb(181, 198, 210));
        help.setTextSize(16);
        help.setGravity(Gravity.CENTER);
        help.setPadding(0, 30, 0, 30);

        Button wifi = new Button(this);
        wifi.setText("Open Wi-Fi settings");
        wifi.setOnClickListener(v -> startActivity(new Intent(Settings.ACTION_WIFI_SETTINGS)));
        Button retry = new Button(this);
        retry.setText("Retry controller");
        retry.setOnClickListener(v -> showController());

        panel.addView(title);
        panel.addView(help);
        panel.addView(wifi);
        panel.addView(retry);
        setContentView(panel);
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
