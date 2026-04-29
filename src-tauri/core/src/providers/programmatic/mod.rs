//! 程序化注册：把所有硬编码 provider 注册到 pathql-rs Registry。
//!
//! 每个 provider 注册函数都是简短一行：`register(reg, "name", |props| Ok(Arc::new(...)))`。
//! 入口 [`register_all_hardcoded`] 在启动期被 `init.rs::provider_runtime()` 调用。

pub mod gallery_albums;
pub mod gallery_dates;
pub mod gallery_filters;
pub mod gallery_root;
pub mod helpers;
pub mod shared;
pub mod vd;

use std::sync::Arc;

use pathql_rs::{Provider, ProviderRegistry};

use self::helpers::register;

/// 注册全部硬编码 provider 到 registry。
pub fn register_all_hardcoded(reg: &mut ProviderRegistry) -> Result<(), pathql_rs::RegistryError> {
    // ── shared ──
    // 7a: sort_provider 已迁移到 DSL (dsl/shared/sort_provider.json5)
    // 纯 contrib leaf, query.order = {"all": "revert"}
    // register(reg, "sort_provider", |_| {
    //     Ok(Arc::new(shared::SortProvider) as Arc<dyn Provider>)
    // })?;
    // 6c: page_size_provider / query_page_provider 由 DSL (shared/*.json5) 接管。
    // 程序化实现仍保留为模块代码以备灰度回退;此处注册位被显式禁用,保证唯一注册路径走 DSL。
    // register(reg, "page_size_provider", |props| {
    //     Ok(Arc::new(shared::PageSizeProvider::from_props(props)?) as Arc<dyn Provider>)
    // })?;
    // register(reg, "query_page_provider", |props| {
    //     Ok(Arc::new(shared::QueryPageProvider::from_props(props)?) as Arc<dyn Provider>)
    // })?;

    // ── root + gallery routes ──
    // 6c: root_provider / gallery_route / gallery_all_router / gallery_paginate_router
    //     由 DSL (root_provider.json + gallery/*.json5) 接管。程序化保留备份, 不再注册。
    // register(reg, "root_provider", |_| {
    //     Ok(Arc::new(gallery_root::RootProvider) as Arc<dyn Provider>)
    // })?;
    // register(reg, "gallery_route", |_| {
    //     Ok(Arc::new(gallery_root::GalleryRouteProvider) as Arc<dyn Provider>)
    // })?;
    // register(reg, "gallery_all_router", |_| {
    //     Ok(Arc::new(gallery_root::GalleryAllRouter) as Arc<dyn Provider>)
    // })?;
    // register(reg, "gallery_paginate_router", |props| {
    //     Ok(Arc::new(gallery_root::GalleryPaginateRouter::from_props(props)?) as Arc<dyn Provider>)
    // })?;

    // ── gallery filters ──
    register(reg, "gallery_albums_router", |_| {
        Ok(Arc::new(gallery_albums::GalleryAlbumsRouter) as Arc<dyn Provider>)
    })?;
    register(reg, "gallery_album_provider", |props| {
        Ok(Arc::new(gallery_albums::GalleryAlbumProvider::from_props(props)?) as Arc<dyn Provider>)
    })?;
    register(reg, "gallery_plugins_router", |_| {
        Ok(Arc::new(gallery_filters::GalleryPluginsRouter) as Arc<dyn Provider>)
    })?;
    register(reg, "gallery_plugin_provider", |props| {
        Ok(Arc::new(gallery_filters::GalleryPluginProvider::from_props(props)?)
            as Arc<dyn Provider>)
    })?;
    register(reg, "gallery_tasks_router", |_| {
        Ok(Arc::new(gallery_filters::GalleryTasksRouter) as Arc<dyn Provider>)
    })?;
    register(reg, "gallery_task_provider", |props| {
        Ok(Arc::new(gallery_filters::GalleryTaskProvider::from_props(props)?) as Arc<dyn Provider>)
    })?;
    register(reg, "gallery_surfs_router", |_| {
        Ok(Arc::new(gallery_filters::GallerySurfsRouter) as Arc<dyn Provider>)
    })?;
    register(reg, "gallery_surf_provider", |props| {
        Ok(Arc::new(gallery_filters::GallerySurfProvider::from_props(props)?) as Arc<dyn Provider>)
    })?;
    register(reg, "gallery_media_type_router", |_| {
        Ok(Arc::new(gallery_filters::GalleryMediaTypeRouter) as Arc<dyn Provider>)
    })?;
    register(reg, "gallery_media_type_provider", |props| {
        Ok(Arc::new(gallery_filters::GalleryMediaTypeProvider::from_props(props)?)
            as Arc<dyn Provider>)
    })?;
    register(reg, "gallery_hide_router", |_| {
        Ok(Arc::new(gallery_filters::GalleryHideRouter) as Arc<dyn Provider>)
    })?;
    // 7a: gallery_search_router 已迁移到 DSL (dsl/gallery/gallery_search_router.json5)
    // 纯 router 壳, list = {"display-name": gallery_search_display_name_router}
    // register(reg, "gallery_search_router", |_| {
    //     Ok(Arc::new(gallery_filters::GallerySearchRouter) as Arc<dyn Provider>)
    // })?;
    register(reg, "gallery_search_display_name_router", |_| {
        Ok(Arc::new(gallery_filters::GallerySearchDisplayNameRouter) as Arc<dyn Provider>)
    })?;
    register(
        reg,
        "gallery_search_display_name_query_provider",
        |props| {
            Ok(Arc::new(
                gallery_filters::GallerySearchDisplayNameQueryProvider::from_props(props)?,
            ) as Arc<dyn Provider>)
        },
    )?;
    register(reg, "gallery_wallpaper_order_router", |_| {
        Ok(Arc::new(gallery_filters::GalleryWallpaperOrderRouter) as Arc<dyn Provider>)
    })?;
    register(reg, "gallery_date_range_router", |_| {
        Ok(Arc::new(gallery_filters::GalleryDateRangeRouter) as Arc<dyn Provider>)
    })?;
    register(reg, "gallery_date_range_entry_provider", |props| {
        Ok(Arc::new(
            gallery_filters::GalleryDateRangeEntryProvider::from_props(props)?,
        ) as Arc<dyn Provider>)
    })?;

    // ── gallery dates ──
    register(reg, "gallery_dates_router", |_| {
        Ok(Arc::new(gallery_dates::GalleryDatesRouter) as Arc<dyn Provider>)
    })?;
    register(reg, "gallery_date_year_provider", |props| {
        Ok(Arc::new(gallery_dates::GalleryDateYearProvider::from_props(props)?)
            as Arc<dyn Provider>)
    })?;
    register(reg, "gallery_date_month_provider", |props| {
        Ok(Arc::new(gallery_dates::GalleryDateMonthProvider::from_props(props)?)
            as Arc<dyn Provider>)
    })?;
    register(reg, "gallery_date_day_provider", |props| {
        Ok(Arc::new(gallery_dates::GalleryDateDayProvider::from_props(props)?)
            as Arc<dyn Provider>)
    })?;

    // ── vd ──
    // 6c: vd_root_router 由 DSL (vd/vd_root_router.json5) 接管。程序化备份不再注册。
    // register(reg, "vd_root_router", |_| {
    //     Ok(Arc::new(vd::VdRootRouter) as Arc<dyn Provider>)
    // })?;
    register(reg, "vd_all_provider", |_| {
        Ok(Arc::new(vd::VdAllProvider) as Arc<dyn Provider>)
    })?;
    register(reg, "vd_albums_provider", |_| {
        Ok(Arc::new(vd::VdAlbumsProvider) as Arc<dyn Provider>)
    })?;
    register(reg, "vd_album_entry_provider", |props| {
        Ok(Arc::new(vd::VdAlbumEntryProvider::from_props(props)?) as Arc<dyn Provider>)
    })?;
    register(reg, "vd_sub_album_gate_provider", |props| {
        Ok(Arc::new(vd::VdSubAlbumGateProvider::from_props(props)?) as Arc<dyn Provider>)
    })?;
    register(reg, "vd_plugins_provider", |_| {
        Ok(Arc::new(vd::VdPluginsProvider) as Arc<dyn Provider>)
    })?;
    register(reg, "vd_tasks_provider", |_| {
        Ok(Arc::new(vd::VdTasksProvider) as Arc<dyn Provider>)
    })?;
    register(reg, "vd_surfs_provider", |_| {
        Ok(Arc::new(vd::VdSurfsProvider) as Arc<dyn Provider>)
    })?;
    register(reg, "vd_media_type_provider", |_| {
        Ok(Arc::new(vd::VdMediaTypeProvider) as Arc<dyn Provider>)
    })?;
    register(reg, "vd_dates_provider", |_| {
        Ok(Arc::new(vd::VdDatesProvider) as Arc<dyn Provider>)
    })?;

    Ok(())
}
