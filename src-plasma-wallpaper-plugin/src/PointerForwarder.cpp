#include "PointerForwarder.hpp"

#include <QMouseEvent>
#include <QScreen>
#include <QtEndian>

#include <cstring>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

namespace {
// 与 Kabegame 的约定版本（仓库根的 PROTOCOL，CMake 传进来）
constexpr quint16 kProtocolVersion = KB_STREAM_PROTOCOL;
constexpr int kMessageLen = 32;

quint32 linuxButton(Qt::MouseButton button)
{
    switch (button) {
    case Qt::LeftButton:
        return 0x110; // BTN_LEFT
    case Qt::RightButton:
        return 0x111; // BTN_RIGHT
    case Qt::MiddleButton:
        return 0x112; // BTN_MIDDLE
    default:
        return 0;
    }
}

quint32 buttonMask(Qt::MouseButtons buttons)
{
    quint32 mask = 0;
    if (buttons & Qt::LeftButton)
        mask |= 1;
    if (buttons & Qt::RightButton)
        mask |= 2;
    if (buttons & Qt::MiddleButton)
        mask |= 4;
    return mask;
}

template<typename T>
void put(unsigned char* out, int at, T value)
{
    const T le = qToLittleEndian(value);
    std::memcpy(out + at, &le, sizeof(T));
}

void putFloat(unsigned char* out, int at, float value)
{
    quint32 bits;
    std::memcpy(&bits, &value, sizeof bits);
    put<quint32>(out, at, bits);
}
} // namespace

KabegamePointerForwarder::KabegamePointerForwarder(QObject* parent)
    : QObject(parent)
{
    m_fd = ::socket(AF_UNIX, SOCK_DGRAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
}

KabegamePointerForwarder::~KabegamePointerForwarder()
{
    if (m_window)
        m_window->removeEventFilter(this);
    if (m_fd >= 0)
        ::close(m_fd);
}

void KabegamePointerForwarder::setTarget(QQuickItem* target)
{
    if (m_target == target)
        return;
    if (m_target)
        disconnect(m_target, nullptr, this, nullptr);
    m_target = target;
    if (m_target) {
        connect(m_target, &QQuickItem::windowChanged, this, &KabegamePointerForwarder::attachWindow);
        attachWindow(m_target->window());
    } else {
        attachWindow(nullptr);
    }
    emit targetChanged();
}

void KabegamePointerForwarder::setInputPath(const QString& path)
{
    if (m_inputPath == path)
        return;
    m_inputPath = path;
    m_inside = false;
    emit inputPathChanged();
}

void KabegamePointerForwarder::setSlot(int slot)
{
    if (m_slot == slot)
        return;
    m_slot = slot;
    m_inside = false;
    emit slotChanged();
}

void KabegamePointerForwarder::attachWindow(QQuickWindow* window)
{
    if (m_window == window)
        return;
    if (m_window)
        m_window->removeEventFilter(this);
    m_window = window;
    m_inside = false;
    if (m_window)
        m_window->installEventFilter(this);
}

bool KabegamePointerForwarder::eventFilter(QObject* watched, QEvent* event)
{
    if (watched == m_window) {
        switch (event->type()) {
        case QEvent::MouseMove:
        case QEvent::MouseButtonPress:
        case QEvent::MouseButtonRelease:
            onMouse(static_cast<QMouseEvent*>(event));
            break;
        case QEvent::Leave:
            // 光标离开了整个桌面窗口（进了别的应用窗口、面板、别的屏）
            sendLeave();
            break;
        default:
            break;
        }
    }
    // 只看不吞：桌面图标、右键菜单照常处理
    return false;
}

void KabegamePointerForwarder::onMouse(QMouseEvent* event)
{
    if (!m_target || m_target->width() <= 0 || m_target->height() <= 0)
        return;
    const QPointF local = m_target->mapFromScene(event->scenePosition());
    const double x = local.x() / m_target->width();
    const double y = local.y() / m_target->height();
    const bool inside = x >= 0 && x < 1 && y >= 0 && y < 1;
    const Qt::MouseButtons buttons = event->buttons();
    // 按着拖出壁纸范围仍照发（Kabegame 那边要配对抬起）；没按键时出了范围算离开
    if (!inside && buttons == Qt::NoButton && event->type() == QEvent::MouseMove) {
        sendLeave();
        return;
    }
    m_inside = true;
    // 光标的全局逻辑坐标：桌面窗口铺满所在的屏，场景坐标 + 屏的左上角（与 KWin 的窗口几何同一套）；Kabegame 用它让主窗口里的
    // 壁纸也跟着桌面上的光标
    QPointF global = event->scenePosition();
    if (m_window && m_window->screen())
        global += QPointF(m_window->screen()->geometry().topLeft());
    if (event->type() == QEvent::MouseMove)
        send(Move, x, y, 0, buttons, global.x(), global.y());
    else
        send(Button, x, y, linuxButton(event->button()), buttons, global.x(), global.y());
}

void KabegamePointerForwarder::sendLeave()
{
    if (!m_inside)
        return;
    m_inside = false;
    send(Leave, 0, 0, 0, Qt::NoButton);
}

void KabegamePointerForwarder::send(Kind kind, double x, double y, quint32 button, Qt::MouseButtons buttons, double dx, double dy)
{
    if (m_fd < 0 || m_slot < 0 || m_inputPath.isEmpty())
        return;
    const QByteArray path = m_inputPath.toLocal8Bit();
    sockaddr_un address {};
    if (path.size() >= int(sizeof(address.sun_path)))
        return;
    address.sun_family = AF_UNIX;
    std::memcpy(address.sun_path, path.constData(), path.size());

    unsigned char message[kMessageLen] = {};
    put<quint16>(message, 0, kProtocolVersion);
    put<quint16>(message, 2, kind);
    put<quint32>(message, 4, quint32(m_slot));
    putFloat(message, 8, float(x));
    putFloat(message, 12, float(y));
    put<quint32>(message, 16, button);
    put<quint32>(message, 20, buttonMask(buttons));
    // 24..31：kind 1 / 2 是光标的全局逻辑坐标，kind 4（滚轮，预留）是 dx / dy
    putFloat(message, 24, float(dx));
    putFloat(message, 28, float(dy));

    // 发不出去（Kabegame 没在跑、缓冲满）就丢
    ::sendto(m_fd, message, kMessageLen, MSG_DONTWAIT | MSG_NOSIGNAL, reinterpret_cast<const sockaddr*>(&address),
             sizeof address);
}
