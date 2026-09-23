#[cfg(target_os = "android")]
use std::sync::mpsc;
#[cfg(target_os = "android")]

/// 在 Android 上获取 JNIEnv 与 Activity 并执行回调。
/// context_jobject 是 tao 持有的全局引用，禁止 Drop（DeleteLocalRef 会破坏引用表）。
#[cfg(target_os = "android")]
fn android_jni<F>(f: F)
where
    F: FnOnce(&mut jni::JNIEnv, &jni::objects::JObject) + Send,
{
    use tauri::tao::platform::android::prelude::main_android_context;
    let Some(ctx) = main_android_context() else {
        return;
    };
    let vm = match unsafe { jni::JavaVM::from_raw(ctx.java_vm.cast()) } {
        Ok(v) => v,
        Err(_) => return,
    };
    let mut guard = match vm.attach_current_thread() {
        Ok(g) => g,
        Err(_) => return,
    };
    let activity = unsafe { jni::objects::JObject::from_raw(ctx.context_jobject.cast()) };
    f(&mut guard, &activity);
    std::mem::forget(activity);
}

/// 通过 activity 的 classloader 加载 APK 内的类（原生 FindClass 找不到 APK 类）
#[cfg(target_os = "android")]
fn load_class<'a>(
    env: &mut jni::JNIEnv<'a>,
    activity: &jni::objects::JObject,
    name: &str,
) -> jni::errors::Result<jni::objects::JClass<'a>> {
    let loader = env
        .call_method(activity, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])?
        .l()?;
    let jname = env.new_string(name)?;
    let cls = env
        .call_method(
            loader,
            "loadClass",
            "(Ljava/lang/String;)Ljava/lang/Class;",
            &[(&jname).into()],
        )?
        .l()?;
    let jclass: jni::objects::JClass = match cls.try_into() {
        Ok(c) => c,
        Err(e) => match e {},
    };
    Ok(jclass)
}

/// 无 JNI 兜底：尝试列出内部存储根目录判断权限
#[cfg(target_os = "android")]
fn fs_probe_all_files_access() -> bool {
    std::fs::read_dir("/storage/emulated/0").is_ok()
}

#[tauri::command]
pub fn check_all_files_access() -> bool {
    #[cfg(target_os = "android")]
    {
        let (tx, rx) = mpsc::channel();
        android_jni(move |env, _| {
            let ok = (|| -> jni::errors::Result<bool> {
                let cls = env.find_class("android/os/Environment")?;
                let res = env.call_static_method(&cls, "isExternalStorageManager", "()Z", &[])?;
                res.z()
            })()
            .unwrap_or(false);
            let _ = tx.send(ok);
        });
        rx.recv().unwrap_or_else(|_| fs_probe_all_files_access())
    }
    #[cfg(not(target_os = "android"))]
    {
        true
    }
}

#[tauri::command]
pub fn request_all_files_access<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    #[cfg(target_os = "android")]
    {
        use jni::objects::JValue;
        let pkg = app.config().identifier.clone();
        android_jni(move |env, activity| {
            let r = (|| -> jni::errors::Result<()> {
                let action =
                    env.new_string("android.settings.MANAGE_APP_ALL_FILES_ACCESS_PERMISSION")?;
                let intent = env.new_object(
                    "android/content/Intent",
                    "(Ljava/lang/String;)V",
                    &[JValue::Object(&action)],
                )?;
                let uri_pkg = env.new_string(format!("package:{pkg}"))?;
                let uri = env
                    .call_static_method(
                        "android/net/Uri",
                        "parse",
                        "(Ljava/lang/String;)Landroid/net/Uri;",
                        &[JValue::Object(&uri_pkg)],
                    )?
                    .l()?;
                env.call_method(
                    &intent,
                    "setData",
                    "(Landroid/net/Uri;)Landroid/content/Intent;",
                    &[JValue::Object(&uri)],
                )?;
                env.call_method(
                    &intent,
                    "addFlags",
                    "(I)Landroid/content/Intent;",
                    &[JValue::Int(0x1000_0000)], // FLAG_ACTIVITY_NEW_TASK
                )?;
                env.call_method(
                    activity,
                    "startActivity",
                    "(Landroid/content/Intent;)V",
                    &[JValue::Object(&intent)],
                )?;
                Ok(())
            })();
            let _ = r;
        });
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
    }
}

/// 通过系统“打开方式”打开文件（FileProvider）
#[tauri::command]
pub fn open_with_system<R: tauri::Runtime>(app: tauri::AppHandle<R>, path: String, mime: String) {
    #[cfg(target_os = "android")]
    {
        use jni::objects::JValue;
        let pkg = app.config().identifier.clone();
        android_jni(move |env, activity| {
            let r = (|| -> jni::errors::Result<()> {
                let jpath = env.new_string(&path)?;
                let jfile = env.new_object(
                    "java/io/File",
                    "(Ljava/lang/String;)V",
                    &[JValue::Object(&jpath)],
                )?;
                let fclass = load_class(env, activity, "androidx/core/content/FileProvider")?;
                let jauth = env.new_string(format!("{pkg}.fileprovider"))?;
                let provider = env
                    .call_static_method(
                        &fclass,
                        "getUriForFile",
                        "(Landroid/content/Context;Ljava/lang/String;Ljava/io/File;)Landroid/net/Uri;",
                        &[activity.into(), JValue::Object(&jauth), JValue::Object(&jfile)],
                    )?
                    .l()?;
                let jmime = env.new_string(if mime.is_empty() { "*/*" } else { mime.as_str() })?;
                let intent = env.new_object(
                    "android/content/Intent",
                    "(Ljava/lang/String;Landroid/net/Uri;)V",
                    &[JValue::Object(&jmime), JValue::Object(&provider)],
                )?;
                env.call_method(
                    &intent,
                    "addFlags",
                    "(I)Landroid/content/Intent;",
                    &[JValue::Int(0x1)], // GRANT_READ_URI_PERMISSION
                )?;
                let chooser = env
                    .call_static_method(
                        "android/content/Intent",
                        "createChooser",
                        "(Landroid/content/Intent;Ljava/lang/CharSequence;)Landroid/content/Intent;",
                        &[JValue::Object(&intent), (&env.new_string("打开文件")?).into()],
                    )?
                    .l()?;
                env.call_method(
                    activity,
                    "startActivity",
                    "(Landroid/content/Intent;)V",
                    &[JValue::Object(&chooser)],
                )?;
                Ok(())
            })();
            let _ = r;
        });
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, path, mime);
    }
}
