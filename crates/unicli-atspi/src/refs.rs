use std::collections::HashMap;

#[derive(Default)]
pub struct RefTable {
    by_alias: HashMap<String, String>,
}

impl RefTable {
    #[allow(dead_code)]
    pub fn alloc(&mut self, stable: impl Into<String>) -> String {
        let alias = format!("@e{}", self.by_alias.len() + 1);
        self.by_alias.insert(alias.clone(), stable.into());
        alias
    }

    #[allow(dead_code)]
    pub fn resolve(&self, alias: &str) -> Option<&str> {
        self.by_alias.get(alias).map(String::as_str)
    }

    pub fn clear(&mut self) {
        self.by_alias.clear();
    }
}
