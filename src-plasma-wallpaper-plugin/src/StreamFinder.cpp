#include "StreamFinder.hpp"

#include <cstdlib>

#include <QMetaObject>

#include <pipewire/pipewire.h>
#include <spa/utils/dict.h>

#include <cstring>

struct BoundNode {
    KabegameStreamFinder* self = nullptr;
    uint32_t id = 0;
    pw_proxy* proxy = nullptr;
    spa_hook listener{};
};

namespace {

const char* dictGet(const spa_dict* props, const char* key) {
    return props ? spa_dict_lookup(props, key) : nullptr;
}

void nodeInfo(void* data, const pw_node_info* info) {
    auto* bound = static_cast<BoundNode*>(data);
    const spa_dict* props = info->props;
    if (!dictGet(props, "kabegame.wallpaper.protocol")) return;

    KabegameStreamFinder::Node node;
    if (const char* s = dictGet(props, PW_KEY_OBJECT_SERIAL)) node.serial = uint32_t(std::strtoul(s, nullptr, 10));
    if (const char* s = dictGet(props, PW_KEY_NODE_NAME)) node.name = QString::fromUtf8(s);
    if (const char* s = dictGet(props, "kabegame.wallpaper.screen")) node.screen = QString::fromUtf8(s);
    if (const char* s = dictGet(props, "kabegame.wallpaper.input")) node.input = QString::fromUtf8(s);
    if (const char* s = dictGet(props, "kabegame.wallpaper.slot")) node.slot = std::atoi(s);
    bound->self->onNodeInfo(bound->id, node);
}

const pw_node_events kNodeEvents = {
    .version = PW_VERSION_NODE_EVENTS,
    .info = nodeInfo,
};

void registryGlobal(void* data, uint32_t id, uint32_t /*permissions*/, const char* type, uint32_t /*version*/,
                    const spa_dict* props) {
    if (std::strcmp(type, PW_TYPE_INTERFACE_Node) != 0) return;
    const char* mediaClass = dictGet(props, PW_KEY_MEDIA_CLASS);
    if (!mediaClass || std::strcmp(mediaClass, "Video/Source") != 0) return;
    static_cast<KabegameStreamFinder*>(data)->onVideoSource(id);
}

void registryGlobalRemove(void* data, uint32_t id) {
    static_cast<KabegameStreamFinder*>(data)->onGlobalRemove(id);
}

const pw_registry_events kRegistryEvents = {
    .version = PW_VERSION_REGISTRY_EVENTS,
    .global = registryGlobal,
    .global_remove = registryGlobalRemove,
};

} // namespace

KabegameStreamFinder::KabegameStreamFinder(QObject* parent) : QObject(parent) {
    pw_init(nullptr, nullptr);
    m_loop = pw_thread_loop_new("kabegame-finder", nullptr);
    m_context = pw_context_new(pw_thread_loop_get_loop(m_loop), nullptr, 0);
    if (pw_thread_loop_start(m_loop) < 0) {
        setStatus(QStringLiteral("pw_thread_loop_start failed"));
        return;
    }
    pw_thread_loop_lock(m_loop);
    m_core = pw_context_connect(m_context, nullptr, 0);
    if (!m_core) {
        pw_thread_loop_unlock(m_loop);
        setStatus(QStringLiteral("pw_context_connect failed"));
        return;
    }
    m_registry = pw_core_get_registry(m_core, PW_VERSION_REGISTRY, 0);
    m_registryListener = new spa_hook{};
    pw_registry_add_listener(m_registry, m_registryListener, &kRegistryEvents, this);
    pw_thread_loop_unlock(m_loop);
    setStatus(QStringLiteral("connected"));
}

KabegameStreamFinder::~KabegameStreamFinder() {
    if (m_loop) pw_thread_loop_stop(m_loop);
    for (auto& [id, bound] : m_bound) {
        spa_hook_remove(&bound->listener);
        pw_proxy_destroy(bound->proxy);
    }
    m_bound.clear();
    if (m_registryListener) {
        spa_hook_remove(m_registryListener);
        delete m_registryListener;
    }
    if (m_registry) pw_proxy_destroy(reinterpret_cast<pw_proxy*>(m_registry));
    if (m_core) pw_core_disconnect(m_core);
    if (m_context) pw_context_destroy(m_context);
    if (m_loop) pw_thread_loop_destroy(m_loop);
}

void KabegameStreamFinder::setScreenName(const QString& name) {
    if (name == m_screenName) return;
    m_screenName = name;
    emit screenNameChanged();
    reselect();
}

void KabegameStreamFinder::onVideoSource(uint32_t id) {
    if (m_bound.count(id)) return;
    auto bound = std::make_unique<BoundNode>();
    bound->self = this;
    bound->id = id;
    bound->proxy = static_cast<pw_proxy*>(pw_registry_bind(m_registry, id, PW_TYPE_INTERFACE_Node, PW_VERSION_NODE, 0));
    if (!bound->proxy) return;
    pw_proxy_add_object_listener(bound->proxy, &bound->listener, &kNodeEvents, bound.get());
    m_bound[id] = std::move(bound);
}

void KabegameStreamFinder::onNodeInfo(uint32_t id, const Node& node) {
    {
        std::lock_guard lock(m_mutex);
        m_nodes[id] = node;
    }
    QMetaObject::invokeMethod(this, [this] { reselect(); }, Qt::QueuedConnection);
}

void KabegameStreamFinder::onGlobalRemove(uint32_t id) {
    if (auto it = m_bound.find(id); it != m_bound.end()) {
        spa_hook_remove(&it->second->listener);
        pw_proxy_destroy(it->second->proxy);
        m_bound.erase(it);
    }
    {
        std::lock_guard lock(m_mutex);
        if (m_nodes.erase(id) == 0) return;
    }
    QMetaObject::invokeMethod(this, [this] { reselect(); }, Qt::QueuedConnection);
}

void KabegameStreamFinder::reselect() {
    Node best;
    bool found = false;
    {
        std::lock_guard lock(m_mutex);
        // 先找绑本屏的，再找不绑屏的；同级取 serial 最大
        for (int pass = 0; pass < 2 && !found; ++pass) {
            for (const auto& [id, node] : m_nodes) {
                const bool match = pass == 0 ? (!m_screenName.isEmpty() && node.screen == m_screenName)
                                             : node.screen.isEmpty();
                if (!match) continue;
                if (!found || node.serial > best.serial) {
                    best = node;
                    found = true;
                }
            }
        }
    }
    const uint serial = found ? best.serial : 0;
    if (serial != m_serial || best.name != m_nodeName || best.input != m_inputPath || best.slot != m_slot) {
        m_serial = serial;
        m_nodeName = found ? best.name : QString();
        m_inputPath = found ? best.input : QString();
        m_slot = found ? best.slot : -1;
        emit selectionChanged();
    }
}

void KabegameStreamFinder::setStatus(const QString& s) {
    if (s == m_status) return;
    m_status = s;
    emit statusChanged();
}
